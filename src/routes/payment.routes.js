import express from "express";
import { handlePaymentWebhook } from "../controllers/webhook.controller.js";
import {
  initiatePayment,
  verifyPayment,
  paymentCallback,
  getTicketByReference,
  quoteFees,
} from "../controllers/payment.controller.js";

const router = express.Router();

/* Alias: some Paystack dashboards were configured with this older
   path — accept webhooks here too (raw body mounted in index.js) */
router.post("/webhook", handlePaymentWebhook);

router.get("/quote", quoteFees);
router.post("/initiate", initiatePayment);
router.post("/payments/verify", verifyPayment);
router.get("/tickets/by-reference/:reference", getTicketByReference);
router.get("/callback", paymentCallback);

export default router;
