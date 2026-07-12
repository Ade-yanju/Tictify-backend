import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";
import User from "../models/User.js";
import AffiliateSignup from "../models/AffiliateSignup.js";
import { sendEmail } from "../services/email.service.js";

const router = express.Router();

const JOIN_FEE = Math.max(100, parseInt(process.env.AFFILIATE_JOIN_FEE) || 1000); // ₦
const PAYSTACK_KEY = process.env.PAYSTACK_SECRET_KEY;
const FRONTEND = process.env.FRONTEND_URL || "https://www.tictify.ng";
const BACKEND = process.env.BACKEND_URL || "https://tictify-backend.onrender.com";

const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ── JOIN: collect details, take the ₦1,000 fee via Paystack.
   The account is only created after payment succeeds. ── */
router.post("/join", joinLimiter, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (name.length < 3) return res.status(400).json({ message: "Full name is required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ message: "A valid email is required" });
    if (password.length < 8)
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    if (await User.findOne({ email }))
      return res.status(409).json({ message: "Email already registered — just log in" });
    if (!PAYSTACK_KEY || !PAYSTACK_KEY.startsWith("sk_"))
      return res.status(503).json({ message: "Payments are not configured yet" });

    const reference = `AFFJOIN-${crypto.randomBytes(10).toString("hex")}`;
    const passwordHash = await bcrypt.hash(password, 12);

    /* one pending signup per email — retrying overwrites it */
    await AffiliateSignup.findOneAndUpdate(
      { email },
      { name, email, passwordHash, reference, amount: JOIN_FEE, status: "PENDING" },
      { upsert: true },
    );

    const init = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: JOIN_FEE * 100, // kobo
        reference,
        callback_url: `${BACKEND}/api/affiliates/join/callback`,
        metadata: { purpose: "affiliate_membership" },
      }),
    });
    const data = await init.json();
    if (!data.status || !data.data?.authorization_url) {
      return res.status(502).json({ message: data.message || "Could not start payment" });
    }

    return res.json({
      paymentUrl: data.data.authorization_url,
      reference,
      fee: JOIN_FEE,
    });
  } catch (err) {
    console.error("AFFILIATE JOIN ERROR:", err);
    return res.status(500).json({ message: "Could not start signup" });
  }
});

/* ── CALLBACK: verify payment → create the account → send them
   to login (their dashboard shows the promo code) ── */
router.get("/join/callback", async (req, res) => {
  try {
    const reference = String(req.query.reference || req.query.trxref || "");
    if (!reference.startsWith("AFFJOIN-")) return res.redirect(`${FRONTEND}/affiliate`);

    const vr = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_KEY}` } },
    );
    const v = await vr.json();
    const paid =
      v.status && v.data?.status === "success" && v.data.amount >= JOIN_FEE * 100;
    if (!paid) return res.redirect(`${FRONTEND}/affiliate?payment=failed`);

    /* atomic: only the first callback creates the account */
    const signup = await AffiliateSignup.findOneAndUpdate(
      { reference, status: "PENDING" },
      { status: "PAID" },
      { new: true },
    );
    if (!signup) return res.redirect(`${FRONTEND}/login?welcome=affiliate`);

    const prefix =
      signup.name.replace(/[^a-zA-Z]/g, "").slice(0, 6).toUpperCase() || "AFF";
    const affiliateCode = `${prefix}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

    let user = await User.findOne({ email: signup.email });
    if (!user) {
      user = await User.create({
        name: signup.name,
        email: signup.email,
        passwordHash: signup.passwordHash,
        role: "affiliate",
        affiliateCode,
        isActive: true,
      });
    }
    signup.affiliateCode = user.affiliateCode || affiliateCode;
    await signup.save();

    sendEmail({
      to: signup.email,
      subject: "Welcome to Tictify Affiliates! 🤝",
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#f9fafb;border-radius:16px;">
          <h2 style="color:#1a1a1a;margin-top:0;">Payment confirmed — you're an affiliate! ✅</h2>
          <div style="background:#fff;padding:20px 24px;border-radius:12px;margin:20px 0;text-align:center;">
            <p style="margin:0 0 8px;color:#666;font-size:13px;">YOUR PROMO CODE</p>
            <p style="margin:0;font-size:28px;font-weight:800;letter-spacing:2px;color:#B8952E;">${signup.affiliateCode}</p>
          </div>
          <p style="color:#555;line-height:1.7;">Log in, pick any event that allows affiliates,
          copy your link, and earn a cut of every ticket sold through it.</p>
          <a href="${FRONTEND}/login" style="display:inline-block;background:#E8C96A;color:#000;padding:13px 28px;border-radius:50px;text-decoration:none;font-weight:bold;">Log in to your dashboard</a>
        </div>
      `,
    }).catch(() => {});

    return res.redirect(`${FRONTEND}/login?welcome=affiliate`);
  } catch (err) {
    console.error("AFFILIATE CALLBACK ERROR:", err);
    return res.redirect(`${FRONTEND}/affiliate?payment=failed`);
  }
});

/* Affiliate dashboard: code, balance, sales totals */
router.get("/me", authenticate, authorize("affiliate"), async (req, res) => {
  try {
    const [wallet, sales] = await Promise.all([
      Wallet.findOne({ organizer: req.user._id }),
      Payment.aggregate([
        { $match: { promoter: req.user.affiliateCode, status: "SUCCESS" } },
        {
          $group: {
            _id: null,
            ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
            salesVolume: { $sum: "$organizerAmount" },
          },
        },
      ]),
    ]);
    res.json({
      name: req.user.name,
      affiliateCode: req.user.affiliateCode,
      balance: wallet?.balance || 0,
      totalEarned: wallet?.totalEarnings || 0,
      ticketsSold: sales[0]?.ticketsSold || 0,
      salesVolume: sales[0]?.salesVolume || 0,
    });
  } catch (err) {
    console.error("AFFILIATE ME ERROR:", err);
    res.status(500).json({ message: "Failed to load dashboard" });
  }
});

/* Events open to affiliates — what they can promote right now */
router.get("/events", authenticate, authorize("affiliate"), async (req, res) => {
  try {
    const events = await Event.find({
      status: "LIVE",
      affiliatesEnabled: true,
      date: { $gt: new Date() },
    })
      .select("title banner bannerFit date location city category affiliatePercent ticketTypes")
      .sort("date")
      .limit(100)
      .lean();

    res.json(
      events.map((e) => ({
        _id: e._id,
        title: e.title,
        banner: e.banner,
        bannerFit: e.bannerFit || "cover",
        date: e.date,
        location: e.location,
        city: e.city,
        category: e.category,
        affiliatePercent: e.affiliatePercent,
        fromPrice: Math.min(...(e.ticketTypes || []).map((t) => t.price ?? 0)),
      })),
    );
  } catch (err) {
    console.error("AFFILIATE EVENTS ERROR:", err);
    res.status(500).json({ message: "Failed to load events" });
  }
});

export default router;
