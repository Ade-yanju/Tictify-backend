import User from "../models/User.js";
import bcrypt from "bcryptjs";
import { sendEmail } from "../services/email.service.js";

/* =====================================================
   EMAIL VERIFICATION HELPERS (OTP at signup)
   Same pattern as the withdrawal confirmation flow:
   6-digit code, sha256 hex hash, 10-min expiry, 5 tries
===================================================== */
const VERIFY_OTP_TTL_MS = 10 * 60 * 1000;
const VERIFY_OTP_MAX_ATTEMPTS = 5;

/* Mutates `user` (does NOT save) and returns the plaintext code */
function setVerifyOtp(user) {
  const otp = String(crypto.randomInt(100000, 1000000));
  user.verifyOtpHash = crypto.createHash("sha256").update(otp).digest("hex");
  user.verifyOtpExpires = new Date(Date.now() + VERIFY_OTP_TTL_MS);
  user.verifyOtpAttempts = 0;
  return otp;
}

function verificationEmailHtml(name, otp) {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#f9fafb;border-radius:16px;">
      <h2 style="color:#1a1a1a;margin-top:0;">Confirm your Tictify account</h2>
      <p style="color:#555;line-height:1.7;">Hi ${name}, welcome to Tictify! Enter this code on the verification screen to activate your account:</p>
      <div style="text-align:center;background:#fff;padding:18px;border-radius:12px;margin:16px 0;">
        <p style="margin:0 0 6px;color:#888;font-size:12px;">YOUR VERIFICATION CODE (expires in 10 minutes)</p>
        <p style="margin:0;font-size:32px;font-weight:800;letter-spacing:8px;color:#1a1a1a;">${otp}</p>
      </div>
      <p style="color:#999;font-size:13px;line-height:1.7;">Didn't create a Tictify account? You can safely ignore this email — nothing happens without this code. Need help? Contact <a href="mailto:tictify@gmail.com" style="color:#B8952E;">tictify@gmail.com</a>.</p>
      <p style="color:#999;font-size:12px;margin-top:24px;">© ${new Date().getFullYear()} Tictify. All rights reserved.</p>
    </div>
  `;
}

function welcomeEmailHtml(name) {
  return `
    <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 32px;">
      <h1 style="color: #22F2A6; margin-bottom: 8px;">Welcome to Tictify, ${name}!</h1>
      <p style="color: #666; margin-bottom: 20px;">Your organizer account is ready to go.</p>

      <div style="background: white; padding: 24px; border-radius: 12px; margin: 24px 0;">
        <h3 style="color: #1a1a1a; margin-top: 0;">Next Steps:</h3>
        <ol style="color: #666; line-height: 1.8;">
          <li>Log in to your account</li>
          <li>Create your first event</li>
          <li>Add ticket tiers and pricing</li>
          <li>Share event link with guests</li>
          <li>Track sales in real-time</li>
        </ol>
      </div>

      <a href="${process.env.FRONTEND_URL}/login" style="display: inline-block; background: #22F2A6; color: #0F0618; padding: 12px 24px; border-radius: 999px; text-decoration: none; font-weight: 600; margin: 24px 0;">
        Login to Tictify
      </a>

      <p style="color: #999; font-size: 12px; margin-top: 32px;">
        © ${new Date().getFullYear()} Tictify. All rights reserved.
      </p>
    </div>
  `;
}

/* Same claims + lifetime as a successful login */
function issueToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
}

export const register = async (req, res) => {
  try {
    const { name, password, role } = req.body;
    const email = String(req.body.email || "").trim().toLowerCase();

    if (role !== "organizer") {
      return res.status(403).json({
        message: "Only organizers can register here — affiliates join at /affiliate",
      });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Name is required" });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "A valid email is required" });
    }

    if (!password || String(password).length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters",
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        message: "Email already registered",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    /* Optional ambassador invite code (?invite=CODE on the register page) */
    const refRaw = String(req.body.referredBy || "").trim().toUpperCase();
    const referredBy = /^[A-Z0-9_-]{2,30}$/.test(refRaw) ? refRaw : undefined;

    /* Affiliates get a personal promo code at signup */
    let affiliateCode;
    if (role === "affiliate") {
      const { randomBytes } = await import("crypto");
      const prefix =
        String(name).replace(/[^a-zA-Z]/g, "").slice(0, 6).toUpperCase() || "AFF";
      affiliateCode = `${prefix}-${randomBytes(2).toString("hex").toUpperCase()}`;
    }

    let user;
    let otp;
    try {
      user = new User({
        name: String(name).trim(),
        email,
        passwordHash,
        role,
        referredBy,
        affiliateCode,
        emailVerified: false, // must confirm the emailed code first
      });
      otp = setVerifyOtp(user);
      await user.save();
    } catch (createErr) {
      // Unique-index race: two simultaneous signups with the same email
      if (createErr.code === 11000) {
        return res.status(409).json({ message: "Email already registered" });
      }
      throw createErr;
    }

    // 📧 SEND VERIFICATION CODE (awaited — the result decides fail-open).
    // sendEmail never throws; it returns { success:false } when the whole
    // provider chain fails. The welcome email now goes out after the code
    // is confirmed (see verifyEmail below).
    const emailResult = await sendEmail({
      to: email,
      subject: "Confirm your Tictify account",
      html: verificationEmailHtml(String(name).trim(), otp),
    });

    if (!emailResult.success) {
      /* AVAILABILITY FAIL-OPEN: a total email outage must never block
         signups. Auto-verify the account and hand back a session. */
      console.warn(
        `⚠️ Verification email could not be sent to ${email} — failing open (account auto-verified):`,
        emailResult.message || emailResult.error || emailResult.errors,
      );
      user.emailVerified = true;
      user.verifyOtpHash = undefined;
      user.verifyOtpExpires = undefined;
      user.verifyOtpAttempts = 0;
      await user.save();

      return res.status(201).json({
        message:
          role === "affiliate"
            ? "Affiliate account created successfully"
            : "Organizer account created successfully",
        affiliateCode,
        token: issueToken(user),
        user: {
          id: user._id,
          name: user.name,
          role: user.role,
        },
      });
    }

    return res.status(201).json({
      requiresVerification: true,
      message: `We sent a 6-digit code to ${email}`,
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    return res.status(500).json({
      message: "Registration failed",
    });
  }
};
import jwt from "jsonwebtoken";

export const login = async (req, res) => {
  try {
    const { password } = req.body;
    const email = String(req.body.email || "").trim().toLowerCase();

    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    /* Correct password but unverified email → no token. Email a fresh
       code (fire-and-forget) so the verification screen just works. */
    if (user.emailVerified === false) {
      const otp = setVerifyOtp(user);
      await user.save();

      sendEmail({
        to: user.email,
        subject: "Confirm your Tictify account",
        html: verificationEmailHtml(user.name, otp),
      }).catch((e) => console.error("Verification email failed:", e.message));

      return res.status(403).json({
        requiresVerification: true,
        message: "Verify your email — we just sent you a new code",
      });
    }

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ message: "Login failed" });
  }
};

/* =====================================================
   VERIFY EMAIL — checks the 6-digit signup code exactly
   like the withdrawal confirm flow. On success the user
   is logged straight in (same response shape as login).
===================================================== */
export const verifyEmail = async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const otp = String(req.body.otp || "").trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "A valid email is required" });
    }
    if (!/^\d{6}$/.test(otp)) {
      return res
        .status(400)
        .json({ message: "Enter the 6-digit code from your email" });
    }

    const user = await User.findOne({ email, isActive: true });
    if (!user || user.emailVerified !== false) {
      return res
        .status(400)
        .json({ message: "No account awaiting verification for that email" });
    }

    if (!user.verifyOtpHash || !user.verifyOtpExpires) {
      return res
        .status(400)
        .json({ message: "No active code — request a new one" });
    }

    if (user.verifyOtpExpires < new Date()) {
      return res
        .status(400)
        .json({ message: "Code expired — request a new code" });
    }

    if (user.verifyOtpAttempts >= VERIFY_OTP_MAX_ATTEMPTS) {
      return res
        .status(400)
        .json({ message: "Too many wrong attempts — request a new code" });
    }

    const hash = crypto.createHash("sha256").update(otp).digest("hex");
    if (hash !== user.verifyOtpHash) {
      user.verifyOtpAttempts += 1;
      await user.save();
      const left = VERIFY_OTP_MAX_ATTEMPTS - user.verifyOtpAttempts;
      return res.status(400).json({
        message: `Wrong code — ${left} attempt${left === 1 ? "" : "s"} left`,
      });
    }

    /* ── Code verified: activate the account + log them in ── */
    user.emailVerified = true;
    user.verifyOtpHash = undefined;
    user.verifyOtpExpires = undefined;
    user.verifyOtpAttempts = 0;
    await user.save();

    // 📧 Welcome email now that the address is confirmed (async)
    sendEmail({
      to: user.email,
      subject: "Welcome to Tictify! 🎟️",
      html: welcomeEmailHtml(user.name),
    }).catch((err) => console.error("Welcome email failed:", err.message));

    return res.json({
      token: issueToken(user),
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("VERIFY EMAIL ERROR:", error);
    return res.status(500).json({ message: "Verification failed" });
  }
};

/* =====================================================
   RESEND VERIFICATION — always answers neutrally (no
   account enumeration). Only actually sends when the
   account exists AND is still unverified.
===================================================== */
const neutralResend = {
  message: "If that account exists, a new code has been sent",
};

export const resendVerification = async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "A valid email is required" });
    }

    const user = await User.findOne({ email, isActive: true });
    if (user && user.emailVerified === false) {
      const otp = setVerifyOtp(user); // fresh code, attempts reset
      await user.save();

      sendEmail({
        to: user.email,
        subject: "Confirm your Tictify account",
        html: verificationEmailHtml(user.name, otp),
      }).catch((e) => console.error("Verification email failed:", e.message));
    }

    return res.json(neutralResend);
  } catch (err) {
    console.error("RESEND VERIFICATION ERROR:", err);
    return res.json(neutralResend);
  }
};

/* =====================================================
   FORGOT PASSWORD — always answers neutrally (no email
   enumeration); emails a 30-minute reset link
===================================================== */
import crypto from "crypto";
import { sendEmail as sendResetEmail } from "../services/email.service.js";

const neutralReset = {
  message: "If that email is registered, a reset link is on its way.",
};

export const forgotPassword = async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "A valid email is required" });
    }

    const user = await User.findOne({ email, isActive: true });
    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      user.resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
      user.resetTokenExp = new Date(Date.now() + 30 * 60 * 1000);
      await user.save();

      const link = `${process.env.FRONTEND_URL}/reset-password/${token}`;
      sendResetEmail({
        to: email,
        subject: "Reset your Tictify password",
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;">
            <h2 style="color:#1a1a1a;">Reset your password</h2>
            <p style="color:#555;line-height:1.7;">Tap the button below to choose a new password.
            This link expires in <strong>30 minutes</strong>.</p>
            <a href="${link}" style="display:inline-block;background:#E8C96A;color:#000;padding:13px 28px;border-radius:50px;text-decoration:none;font-weight:bold;margin:14px 0;">Choose a new password</a>
            <p style="color:#999;font-size:12px;">Didn't request this? You can safely ignore this email — your password stays unchanged.</p>
          </div>
        `,
      }).catch((e) => console.error("Reset email failed:", e.message));
    }

    return res.json(neutralReset);
  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    return res.json(neutralReset);
  }
};

export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || typeof token !== "string") {
      return res.status(400).json({ message: "Invalid reset link" });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      resetTokenHash: tokenHash,
      resetTokenExp: { $gt: new Date() },
    });
    if (!user) {
      return res.status(400).json({
        message: "This reset link is invalid or has expired. Request a new one.",
      });
    }

    user.passwordHash = await bcrypt.hash(password, 12);
    user.resetTokenHash = undefined;
    user.resetTokenExp = undefined;
    await user.save();

    return res.json({ message: "Password updated — you can log in now." });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    return res.status(500).json({ message: "Could not reset password" });
  }
};
