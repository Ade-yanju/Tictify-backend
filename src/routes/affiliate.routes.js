import express from "express";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";

const router = express.Router();

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
      .select("title banner date location city category affiliatePercent ticketTypes")
      .sort("date")
      .limit(100)
      .lean();

    res.json(
      events.map((e) => ({
        _id: e._id,
        title: e.title,
        banner: e.banner,
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
