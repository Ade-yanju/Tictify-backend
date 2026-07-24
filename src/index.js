import dotenv from "dotenv";
dotenv.config();

import express from "express";
import mongoose from "mongoose";
import cors from "cors";

import authRoutes from "./routes/auth.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import ticketRoutes from "./routes/ticket.routes.js";
import eventRoutes from "./routes/event.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import salesRoutes from "./routes/sales.routes.js";
import withdrawalRoutes from "./routes/withdrawal.routes.js";
import organizerRoutes from "./routes/organizer.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import adminWithdrawalRoutes from "./routes/admin.withdrawal.routes.js";
import walletRoutes from "./routes/wallet.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import ambassadorRoutes from "./routes/ambassador.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import discountRoutes from "./routes/discount.routes.js";
import affiliateRoutes from "./routes/affiliate.routes.js";
import whatsappRoutes from "./routes/whatsapp.routes.js";
import { processPendingPayouts } from "./services/payoutQueue.service.js";
import { reconcileAllSold } from "./services/soldReconcile.service.js";

const app = express();

/* Render/Heroku sit behind a reverse proxy — without this,
   express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
   on every rate-limited route (breaking register/login in prod)
   and counts all users as one IP. */
app.set("trust proxy", 1);

/* ================= CORS ================= */
const allowedOrigins = [
  "https://tictify.vercel.app",
  "https://www.tictify.ng",
];
// Any localhost/127.0.0.1 port is allowed in development
const localhostRegex = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (localhostRegex.test(origin) || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Disallow without throwing — the browser blocks it, the server stays quiet
      return callback(null, false);
    },
    credentials: true,
  }),
);
/* Webhooks need the RAW body for HMAC signature verification —
   this must be registered BEFORE express.json() or the signature
   check receives a parsed object and always fails. */
app.use("/api/webhooks", express.raw({ type: "application/json" }));
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));
app.use("/api/whatsapp/webhook", express.raw({ type: "application/json" }));

app.use(express.json());

/* Version-stamped health check — proves which build is serving */
app.get("/api/health", (req, res) =>
  res.json({ ok: true, version: "slugs-recount-v1" }),
);

/* ================= ROUTES ================= */
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/withdrawals", withdrawalRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/organizer", organizerRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", adminWithdrawalRoutes);
app.use("/api/organizer/wallet", walletRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/ambassadors", ambassadorRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/discounts", discountRoutes);
app.use("/api/affiliates", affiliateRoutes);
app.use("/api/whatsapp", whatsappRoutes);

/* ================= SERVER ================= */
const PORT = process.env.PORT || 5000;

await mongoose.connect(process.env.MONGO_URI);
console.log("MongoDB connected");

// Bind explicitly to 0.0.0.0 so Render's port scanner always sees us
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

/* Self-driving payouts: withdrawals whose instant transfer couldn't
   fire (T+1 settlement gap, transient Paystack errors) are paid
   automatically as soon as the settled balance covers them — no admin
   needed. Runs in-process to stay on Render's free tier; the GitHub
   Actions keepalive stops the dyno from sleeping between ticks. */
const PAYOUT_SWEEP_MS = 10 * 60 * 1000;
setInterval(
  () => processPendingPayouts().catch((e) => console.error("SWEEP:", e)),
  PAYOUT_SWEEP_MS,
);
setTimeout(
  () => processPendingPayouts().catch((e) => console.error("SWEEP:", e)),
  20 * 1000, // catch-up pass shortly after every deploy/restart
);

/* Self-healing sold counters: each tier's `sold` is recounted from the
   SUCCESS payments that are its only real source of truth, so a missed
   increment can't silently corrupt what guests see OR what checkout
   allows. Backfills missing event slugs in the same pass. Offset from
   the payout catch-up so two sweeps never fight for the same dyno. */
const SOLD_SWEEP_MS = 15 * 60 * 1000;
setInterval(
  () => reconcileAllSold().catch((e) => console.error("SOLD SWEEP:", e)),
  SOLD_SWEEP_MS,
);
setTimeout(
  () => reconcileAllSold().catch((e) => console.error("SOLD SWEEP:", e)),
  60 * 1000, // catch-up pass ~60s after boot
);
