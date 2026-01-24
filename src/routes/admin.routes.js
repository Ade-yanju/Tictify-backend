import express from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { adminOnly } from "../middlewares/admin.middleware.js";

import { adminDashboard } from "../controllers/admin.dashboard.controller.js";
import { adminAnalytics } from "../controllers/admin.analytics.controller.js";
import {
  getAdminOrganizers,
  getAdminEvents,
} from "../controllers/admin.controller.js";

import {
  getAllWithdrawals,
  approveWithdrawal,
} from "../controllers/withdrawal.controller.js";

const router = express.Router();

/* ================= ADMIN DASHBOARD ================= */
router.get("/dashboard", authenticate, adminOnly, adminDashboard);

/* ================= ANALYTICS ================= */
router.get("/analytics", authenticate, adminOnly, adminAnalytics);

/* ================= ORGANIZERS ================= */
router.get("/organizers", authenticate, adminOnly, getAdminOrganizers);

/* ================= EVENTS ================= */
router.get("/events", authenticate, adminOnly, getAdminEvents);

/* ================= WITHDRAWALS ================= */
router.get("/withdrawals", authenticate, adminOnly, getAllWithdrawals);

router.patch(
  "/withdrawals/:id/approve",
  authenticate,
  adminOnly,
  approveWithdrawal,
);

export default router;
