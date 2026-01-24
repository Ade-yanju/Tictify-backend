import express from "express";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import {
  requestWithdrawal,
  approveWithdrawal,
} from "../controllers/withdrawal.controller.js";

const router = express.Router();

/* ===== ORGANIZER ===== */
router.post(
  "/request",
  authenticate,
  authorize("organizer"),
  requestWithdrawal,
);

/* ===== ADMIN ===== */
router.patch(
  "/approve/:id",
  authenticate,
  authorize("admin"),
  approveWithdrawal,
);

export default router;
