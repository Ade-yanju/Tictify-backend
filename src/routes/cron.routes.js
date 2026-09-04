import express from "express";
import crypto from "crypto";
import { sendUpcomingEventReminders, sendPostEventReports } from "../services/eventReminder.service.js";
import { processPendingPayouts } from "../services/payoutQueue.service.js";

const router = express.Router();

function authorized(req) {
  const configured = process.env.CRON_SECRET;
  const supplied = req.get("x-cron-secret") || req.query.secret;
  if (!configured || !supplied) return false;
  return supplied.length === configured.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(configured));
}

router.all("/event-reminders", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ message: "Unauthorized" });
  try {
    await sendUpcomingEventReminders();
    await sendPostEventReports();
    res.json({ ok: true, message: "Event reminders processed" });
  } catch (err) {
    console.error("CRON REMINDER ERROR:", err);
    res.status(500).json({ message: "Reminder processing failed" });
  }
});

// Use this from Render Cron, GitHub Actions, or UptimeRobot so queued
// payouts continue progressing even when the web dyno is sleeping.
router.all("/payouts", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ message: "Unauthorized" });
  try {
    await processPendingPayouts();
    res.json({ ok: true, message: "Pending payouts processed" });
  } catch (err) {
    console.error("CRON PAYOUT ERROR:", err);
    res.status(500).json({ message: "Payout processing failed" });
  }
});

export default router;
