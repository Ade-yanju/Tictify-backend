import express from "express";
import { handlePaymentWebhook } from "../controllers/webhook.controller.js";

const router = express.Router();

/**
 * ErcasPay Webhook
 * Called by payment gateway after payment
 */
router.post(
  "/webhook/paystack",
  express.raw({ type: "application/json" }),
  handlePaymentWebhook,
);

export default router;
