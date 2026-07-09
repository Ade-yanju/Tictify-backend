import express from "express";
import rateLimit from "express-rate-limit";
import PushSubscription from "../models/PushSubscription.js";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";

const router = express.Router();

const subLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/* Public VAPID key for the browser's pushManager.subscribe() */
router.get("/vapid-public-key", (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ message: "Push not configured" });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

/* Guests: subscribe to new-event alerts (no login needed) */
router.post("/subscribe", subLimiter, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ message: "Invalid subscription" });
    }
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { endpoint, keys, topic: "events" },
      { upsert: true },
    );
    res.status(201).json({ message: "Subscribed to event alerts" });
  } catch (err) {
    console.error("SUBSCRIBE ERROR:", err);
    res.status(500).json({ message: "Subscription failed" });
  }
});

/* Organizers: subscribe to their own ticket-sale alerts */
router.post(
  "/subscribe-sales",
  subLimiter,
  authenticate,
  authorize("organizer"),
  async (req, res) => {
    try {
      const { endpoint, keys } = req.body || {};
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return res.status(400).json({ message: "Invalid subscription" });
      }
      await PushSubscription.findOneAndUpdate(
        { endpoint },
        { endpoint, keys, topic: "sales", organizer: req.user._id },
        { upsert: true },
      );
      res.status(201).json({ message: "Sale alerts enabled" });
    } catch (err) {
      console.error("SUBSCRIBE SALES ERROR:", err);
      res.status(500).json({ message: "Subscription failed" });
    }
  },
);

export default router;
