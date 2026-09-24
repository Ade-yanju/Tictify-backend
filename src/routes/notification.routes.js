import express from "express";
import rateLimit from "express-rate-limit";
import PushSubscription from "../models/PushSubscription.js";
import Notification from "../models/Notification.js";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";

const router = express.Router();

const subLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const notificationRoles = authorize("organizer", "ambassador", "affiliate", "admin");

function notificationView(item) {
  return {
    id: String(item._id),
    type: item.type,
    title: item.title,
    message: item.message,
    href: item.href || "/organizer/dashboard",
    read: Boolean(item.readAt),
    createdAt: item.createdAt,
  };
}

/* In-app inbox. The recipient filter is mandatory so users can only ever
   read or mutate their own notifications. */
router.get("/", authenticate, notificationRoles, async (req, res) => {
  try {
    const requested = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), 50)
      : 24;
    const filter = { recipient: req.user.id };
    const [items, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ ...filter, readAt: null }),
    ]);
    return res.json({ notifications: items.map(notificationView), unreadCount });
  } catch (err) {
    console.error("NOTIFICATION LIST ERROR:", err);
    return res.status(500).json({ message: "Could not load notifications" });
  }
});

router.patch("/:id/read", authenticate, notificationRoles, async (req, res) => {
  try {
    const item = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user.id, readAt: null },
      { $set: { readAt: new Date() } },
      { new: true },
    ).lean();
    if (!item) return res.status(404).json({ message: "Notification not found" });
    return res.json({ notification: notificationView(item) });
  } catch (err) {
    console.error("NOTIFICATION READ ERROR:", err);
    return res.status(500).json({ message: "Could not update notification" });
  }
});

router.post("/read-all", authenticate, notificationRoles, async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { recipient: req.user.id, readAt: null },
      { $set: { readAt: new Date() } },
    );
    return res.json({ updated: result.modifiedCount || 0 });
  } catch (err) {
    console.error("NOTIFICATION READ ALL ERROR:", err);
    return res.status(500).json({ message: "Could not update notifications" });
  }
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
