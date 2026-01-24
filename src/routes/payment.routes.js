import express from "express";
import { initiatePayment } from "../controllers/payment.controller.js";
import { paymentSuccess } from "../controllers/payment.success.controller.js";
const router = express.Router();

router.post("/initiate", initiatePayment);
router.get("/success", paymentSuccess);

export default router;
