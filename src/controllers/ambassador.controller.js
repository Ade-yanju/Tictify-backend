import crypto from "crypto";
import bcrypt from "bcryptjs";
import Ambassador from "../models/Ambassador.js";
import User from "../models/User.js";
import Payment from "../models/Payment.js";
import { sendEmail } from "../services/email.service.js";

const FRONTEND = process.env.FRONTEND_URL || "https://www.tictify.ng";

/* =====================================================
   APPLY — public form at /campusambassadors
===================================================== */
export const applyAmbassador = async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const fullName = String(req.body.fullName || "").trim();
    const university = String(req.body.university || "").trim();
    const whatsapp = String(req.body.whatsapp || "").trim();
    const motivation = String(req.body.motivation || "").trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ message: "A valid email is required" });
    if (fullName.length < 3)
      return res.status(400).json({ message: "Full name is required" });
    if (!university)
      return res.status(400).json({ message: "University is required" });
    if (!/^\+?\d{10,15}$/.test(whatsapp.replace(/[\s-]/g, "")))
      return res.status(400).json({ message: "A valid WhatsApp number is required" });
    if (motivation.length < 20)
      return res.status(400).json({
        message: "Tell us a bit more about why you want to join (min 20 characters)",
      });

    const existing = await Ambassador.findOne({ email });
    if (existing) {
      return res.status(409).json({
        message:
          existing.status === "APPLIED"
            ? "You've already applied — we'll get back to you soon!"
            : "This email has already been processed for the programme.",
      });
    }

    const application = await Ambassador.create({
      fullName,
      email,
      university,
      department: String(req.body.department || "").trim(),
      level: String(req.body.level || "").trim(),
      whatsapp,
      socials: String(req.body.socials || "").trim(),
      motivation,
      organizersKnown: Math.max(0, Number(req.body.organizersKnown) || 0),
      organizationsCount: Math.max(0, Number(req.body.organizationsCount) || 0),
    });

    /* Confirmation email (non-blocking) */
    sendEmail({
      to: email,
      subject: "We received your Tictify Campus Partners application! 🎓",
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#f9fafb;border-radius:16px;">
          <h2 style="color:#1a1a1a;margin-top:0;">Application received, ${fullName.split(" ")[0]}! ✅</h2>
          <p style="color:#555;line-height:1.7;">
            Thanks for applying to become a <strong>Tictify Campus Partner</strong> at
            <strong>${university}</strong>. Our team reviews every application personally —
            <strong>we'll get back to you</strong> within a few days.
          </p>
          <div style="background:#fff;padding:18px 22px;border-radius:12px;border-left:4px solid #E8C96A;margin:20px 0;">
            <p style="margin:0;color:#666;font-size:14px;line-height:1.8;">
              <strong>What happens next:</strong><br/>
              1. We review your application<br/>
              2. A short chat (only if needed)<br/>
              3. Acceptance email with your ambassador account & invite code<br/>
              4. Training, then you start onboarding organizers & earning
            </p>
          </div>
          <p style="font-size:12px;color:#999;">© ${new Date().getFullYear()} Tictify · Events made easy. Tickets made simple.</p>
        </div>
      `,
    }).catch((e) => console.error("Ambassador confirmation email failed:", e.message));

    return res.status(201).json({
      message:
        "Application received! Check your inbox — we'll get back to you within a few days.",
      applicationId: application._id,
    });
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ message: "You've already applied." });
    console.error("AMBASSADOR APPLY ERROR:", err);
    return res.status(500).json({ message: "Could not submit application" });
  }
};

/* =====================================================
   ADMIN — list / approve / reject
===================================================== */
export const adminListAmbassadors = async (req, res) => {
  try {
    const list = await Ambassador.find().sort("-createdAt");
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: "Failed to load applications" });
  }
};

function makeInviteCode(fullName) {
  const prefix = fullName
    .replace(/[^a-zA-Z]/g, "")
    .slice(0, 6)
    .toUpperCase() || "PARTNER";
  return `${prefix}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

export const adminApproveAmbassador = async (req, res) => {
  try {
    /* Atomic claim */
    const app = await Ambassador.findOneAndUpdate(
      { _id: req.params.id, status: "APPLIED" },
      { status: "APPROVED", processedBy: req.user._id, processedAt: new Date() },
      { new: true },
    );
    if (!app) {
      const exists = await Ambassador.findById(req.params.id);
      return exists
        ? res.status(400).json({ message: "Already processed" })
        : res.status(404).json({ message: "Application not found" });
    }

    /* Create the ambassador account with a generated password */
    const tempPassword = crypto.randomBytes(5).toString("hex"); // 10 chars
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const inviteCode = makeInviteCode(app.fullName);

    let user = await User.findOne({ email: app.email });
    if (!user) {
      user = await User.create({
        name: app.fullName,
        email: app.email,
        passwordHash,
        role: "ambassador",
        isActive: true,
      });
    } else {
      // Existing account (e.g. organizer) — grant ambassador role too
      user.role = "ambassador";
      await user.save();
    }

    app.user = user._id;
    app.inviteCode = inviteCode;
    await app.save();

    /* Acceptance email with credentials + invite code */
    const passwordBlock =
      user.passwordHash === passwordHash
        ? `<p style="margin:6px 0;"><strong>Temporary password:</strong> <code style="background:#f0f0f0;padding:3px 8px;border-radius:6px;">${tempPassword}</code></p>
           <p style="color:#B8952E;font-size:13px;margin:8px 0 0;">Please change it after your first login — use "Forgot password?" on the login page to set your own.</p>`
        : `<p style="margin:6px 0;color:#666;font-size:14px;">Log in with your existing Tictify password.</p>`;

    sendEmail({
      to: app.email,
      subject: "You're in! Welcome to Tictify Campus Partners 🎉",
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#f9fafb;border-radius:16px;">
          <h2 style="color:#1a1a1a;margin-top:0;">Congratulations, ${app.fullName.split(" ")[0]} — you're a Tictify Campus Partner! 🎓</h2>
          <p style="color:#555;line-height:1.7;">Your ambassador account is ready. Here's everything you need:</p>

          <div style="background:#fff;padding:20px 24px;border-radius:12px;border-left:4px solid #E8C96A;margin:20px 0;">
            <p style="margin:6px 0;"><strong>Login email:</strong> ${app.email}</p>
            ${passwordBlock}
          </div>

          <div style="background:#fff;padding:20px 24px;border-radius:12px;margin:20px 0;text-align:center;">
            <p style="margin:0 0 8px;color:#666;font-size:13px;">YOUR INVITE CODE</p>
            <p style="margin:0;font-size:28px;font-weight:800;letter-spacing:2px;color:#B8952E;">${inviteCode}</p>
            <p style="margin:12px 0 0;color:#666;font-size:13px;line-height:1.7;">
              Organizers who sign up with your code are credited to you, and any event link
              you share as <code>?ref=${inviteCode}</code> tracks every ticket you sell.
            </p>
          </div>

          <a href="${FRONTEND}/login" style="display:inline-block;background:#E8C96A;color:#000;padding:13px 28px;border-radius:50px;text-decoration:none;font-weight:bold;">Log in to your dashboard</a>
          <p style="font-size:12px;color:#999;margin-top:26px;">© ${new Date().getFullYear()} Tictify Campus Partners</p>
        </div>
      `,
    }).catch((e) => console.error("Acceptance email failed:", e.message));

    return res.json({ message: "Approved — account created & email sent", inviteCode });
  } catch (err) {
    console.error("AMBASSADOR APPROVE ERROR:", err);
    return res.status(500).json({ message: "Approval failed" });
  }
};

export const adminRejectAmbassador = async (req, res) => {
  try {
    const app = await Ambassador.findOneAndUpdate(
      { _id: req.params.id, status: "APPLIED" },
      { status: "REJECTED", processedBy: req.user._id, processedAt: new Date() },
      { new: true },
    );
    if (!app) {
      const exists = await Ambassador.findById(req.params.id);
      return exists
        ? res.status(400).json({ message: "Already processed" })
        : res.status(404).json({ message: "Application not found" });
    }

    sendEmail({
      to: app.email,
      subject: "Your Tictify Campus Partners application",
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;">
          <p>Hi ${app.fullName.split(" ")[0]},</p>
          <p style="color:#555;line-height:1.7;">Thank you for applying to Tictify Campus Partners.
          After careful review we won't be moving forward this cycle — but the programme grows every
          semester and we'd love to see you apply again.</p>
          <p style="color:#999;font-size:12px;">© ${new Date().getFullYear()} Tictify</p>
        </div>
      `,
    }).catch(() => {});

    return res.json({ message: "Application rejected" });
  } catch (err) {
    return res.status(500).json({ message: "Rejection failed" });
  }
};

/* =====================================================
   AMBASSADOR DASHBOARD — their code + live impact stats
===================================================== */
export const ambassadorDashboard = async (req, res) => {
  try {
    const profile = await Ambassador.findOne({ user: req.user._id });
    if (!profile || profile.status !== "APPROVED") {
      return res.status(404).json({ message: "Ambassador profile not found" });
    }

    const [organizersOnboarded, salesAgg, wallet] = await Promise.all([
      User.countDocuments({ referredBy: profile.inviteCode, role: "organizer" }),
      Payment.aggregate([
        { $match: { promoter: profile.inviteCode, status: "SUCCESS" } },
        {
          $group: {
            _id: null,
            ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
            revenue: { $sum: "$organizerAmount" },
          },
        },
      ]),
      (await import("../models/Wallet.js")).default.findOne({
        organizer: req.user._id,
      }),
    ]);

    return res.json({
      fullName: profile.fullName,
      university: profile.university,
      inviteCode: profile.inviteCode,
      stats: {
        organizersOnboarded,
        ticketsSold: salesAgg[0]?.ticketsSold || 0,
        salesRevenue: salesAgg[0]?.revenue || 0,
        commissionBalance: wallet?.balance || 0,
        commissionEarned: wallet?.totalEarnings || 0,
      },
    });
  } catch (err) {
    console.error("AMBASSADOR DASHBOARD ERROR:", err);
    return res.status(500).json({ message: "Failed to load dashboard" });
  }
};
