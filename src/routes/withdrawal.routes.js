import express from "express";
import rateLimit from "express-rate-limit";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import { requireWhatsApp } from "../middlewares/requireWhatsApp.js";
import {
  requestWithdrawal,
  confirmWithdrawal,
  getAllWithdrawals, // Added this back so you can still view history
  getWithdrawalStatus,
  getWithdrawalBanks,
} from "../controllers/withdrawal.controller.js";

const router = express.Router();

const withdrawalRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many withdrawal requests. Please try again later." },
});

const withdrawalOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many confirmation attempts. Please try again later." },
});

/* ===== ORGANIZER ===== */
router.get(
  "/banks",
  authenticate,
  authorize("organizer", "ambassador", "affiliate"),
  getWithdrawalBanks,
);

// This now handles the full instant Paystack transfer
router.post(
  "/request",
  withdrawalRequestLimiter,
  authenticate,
  authorize("organizer", "ambassador", "affiliate"), // partners & affiliates withdraw too
  requireWhatsApp, // payouts need a reachable number on file
  requestWithdrawal,
);

/* Step 2: enter the emailed 6-digit code — only then does money move */
router.post(
  "/:withdrawalId/confirm",
  withdrawalOtpLimiter,
  authenticate,
  authorize("organizer", "ambassador", "affiliate"),
  confirmWithdrawal,
);

router.get(
  "/:withdrawalId/status",
  authenticate,
  authorize("organizer", "ambassador", "affiliate"),
  getWithdrawalStatus,
);

/* ===== ORGANIZER HISTORY ===== */
// The admin list is mounted separately under /api/admin/withdrawals.
router.get(
  "/all",
  authenticate,
  authorize("organizer", "ambassador", "affiliate"),
  getAllWithdrawals,
);

export default router;
