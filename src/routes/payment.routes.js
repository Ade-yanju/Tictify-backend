import express from "express";
import rateLimit from "express-rate-limit";
import { handlePaymentWebhook } from "../controllers/webhook.controller.js";
import {
  initiatePayment,
  verifyPayment,
  paymentCallback,
  getTicketByReference,
  quoteFees,
} from "../controllers/payment.controller.js";
import { getPaymentStatus } from "../controllers/payment.status.controller.js";

const router = express.Router();

/* Status polling: a waiting transfer guest polls every 5s for ~20 min
   (~240 hits). Generous ceiling that still caps reference-guessing. */
const statusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many status checks. Try again later." },
});

/* Alias: some Paystack dashboards were configured with this older
   path — accept webhooks here too (raw body mounted in index.js) */
router.post("/webhook", handlePaymentWebhook);

router.get("/quote", quoteFees);
router.post("/initiate", initiatePayment);
router.post("/payments/verify", verifyPayment);
router.get("/status/:reference", statusLimiter, getPaymentStatus);
router.get("/tickets/by-reference/:reference", getTicketByReference);
router.get("/callback", paymentCallback);

export default router;
