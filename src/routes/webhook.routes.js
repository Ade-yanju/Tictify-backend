import express from "express";
import { handlePaymentWebhook } from "../controllers/webhook.controller.js";

const router = express.Router();

/**
 * Paystack Webhook — charge confirmations AND transfer verdicts.
 * Configure in the Paystack dashboard as:
 *   https://<backend>/api/webhooks/paystack
 * (the legacy /webhook/paystack path still works)
 * Raw body is provided by the app-level express.raw() mount in index.js.
 */
router.post("/paystack", handlePaymentWebhook);
router.post("/webhook/paystack", handlePaymentWebhook);

export default router;
