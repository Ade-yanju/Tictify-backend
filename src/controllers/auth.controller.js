import User from "../models/User.js";
import bcrypt from "bcryptjs";
import { sendEmail } from "../services/email.service.js";

export const register = async (req, res) => {
  try {
    const { name, password, role } = req.body;
    const email = String(req.body.email || "").trim().toLowerCase();

    if (role !== "organizer") {
      return res.status(403).json({
        message: "Only organizers can register",
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

    let user;
    try {
      user = await User.create({
        name: String(name).trim(),
        email,
        passwordHash,
        role,
        referredBy,
      });
    } catch (createErr) {
      // Unique-index race: two simultaneous signups with the same email
      if (createErr.code === 11000) {
        return res.status(409).json({ message: "Email already registered" });
      }
      throw createErr;
    }

    // 📧 SEND WELCOME EMAIL (async, don't block response)
    sendEmail({
      to: email,
      subject: "Welcome to Tictify! 🎟️",
      html: `
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
      `,
    }).catch(err => console.error("Welcome email failed:", err.message));

    return res.status(201).json({
      message: "Organizer account created successfully",
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
