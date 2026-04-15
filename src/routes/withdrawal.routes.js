import express from "express";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import {
  requestWithdrawal,
  getAllWithdrawals, // Added this back so you can still view history
} from "../controllers/withdrawal.controller.js";

const router = express.Router();

/* ===== ORGANIZER ===== */
// This now handles the full instant Paystack transfer
router.post(
  "/request",
  authenticate,
  authorize("organizer"),
  requestWithdrawal,
);

/* ===== ADMIN ===== */
// We removed the "approve" route because it's now instant!
// I've added the "all" route here so admins can still monitor the logs.
router.get("/all", authenticate, authorize("admin"), getAllWithdrawals);

export default router;
