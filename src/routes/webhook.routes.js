import express from "express";
import { handlePaymentWebhook } from "../controllers/webhook.controller.js";

const router = express.Router();

/**
 * ErcasPay Webhook
 * Called by payment gateway after payment
 */
router.post("/ercaspay", handlePaymentWebhook);

export default router;
