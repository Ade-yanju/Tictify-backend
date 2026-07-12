import express from "express";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import {
  requestWithdrawal,
  confirmWithdrawal,
  getAllWithdrawals, // Added this back so you can still view history
} from "../controllers/withdrawal.controller.js";

const router = express.Router();

/* ===== ORGANIZER ===== */
// This now handles the full instant Paystack transfer
router.post(
  "/request",
  authenticate,
  authorize("organizer", "ambassador", "affiliate"), // partners & affiliates withdraw too
  requestWithdrawal,
);

/* Step 2: enter the emailed 6-digit code — only then does money move */
router.post(
  "/:withdrawalId/confirm",
  authenticate,
  authorize("organizer", "ambassador", "affiliate"),
  confirmWithdrawal,
);

/* ===== ADMIN ===== */
// We removed the "approve" route because it's now instant!
// I've added the "all" route here so admins can still monitor the logs.
router.get("/all", authenticate, authorize("admin"), getAllWithdrawals);

export default router;
