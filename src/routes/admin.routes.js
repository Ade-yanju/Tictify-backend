import express from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { adminOnly } from "../middlewares/admin.middleware.js";

import { adminDashboard } from "../controllers/admin.dashboard.controller.js";
import { adminAnalytics } from "../controllers/admin.analytics.controller.js";
import {
  getAdminOrganizers,
  getAdminEvents,
} from "../controllers/admin.controller.js";

const router = express.Router();

/* ================= ADMIN DASHBOARD ================= */
router.get("/dashboard", authenticate, adminOnly, adminDashboard);

/* ================= ANALYTICS ================= */
router.get("/analytics", authenticate, adminOnly, adminAnalytics);

/* ================= ORGANIZERS ================= */
router.get("/organizers", authenticate, adminOnly, getAdminOrganizers);

/* ================= EVENTS ================= */
router.get("/events", authenticate, adminOnly, getAdminEvents);

/* NOTE: /withdrawals (list, approve, reject) lives in
   admin.withdrawal.routes.js — do not redefine it here.
   A duplicate GET /withdrawals previously shadowed the real
   admin controller with the organizer-scoped one, so the
   admin panel always showed an empty list. */

export default router;
