import express from "express";
import {
  initiatePayment,
  getPaymentStatus,
  paymentCallback,
} from "../controllers/payment.controller.js";

const router = express.Router();

router.post("/initiate", initiatePayment);
router.get("/status/:reference", getPaymentStatus);
router.get("/callback", paymentCallback);

export default router;
