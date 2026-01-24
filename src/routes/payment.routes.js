import express from "express";
import { initiatePayment, getPaymentStatus } from "../controllers/payment.controller.js";

const router = express.Router();

router.post("/initiate", initiatePayment);
router.get("/status/:reference", getPaymentStatus);

export default router;
