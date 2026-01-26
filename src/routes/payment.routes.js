import express from "express";
import {
  initiatePayment,
  verifyPayment,
  paymentCallback,
} from "../controllers/payment.controller.js";

const router = express.Router();

router.post("/initiate", initiatePayment);
router.post("/verify", verifyPayment);
router.get("/callback", paymentCallback);

export default router;
