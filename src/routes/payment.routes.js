import express from "express";
import {
  initiatePayment,
  verifyPayment,
  paymentCallback,
  getTicketByReference,
  quoteFees,
} from "../controllers/payment.controller.js";

const router = express.Router();

router.get("/quote", quoteFees);
router.post("/initiate", initiatePayment);
router.post("/payments/verify", verifyPayment);
router.get("/tickets/by-reference/:reference", getTicketByReference);
router.get("/callback", paymentCallback);

export default router;
