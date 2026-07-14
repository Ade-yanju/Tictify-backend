import express from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { adminOnly } from "../middlewares/admin.middleware.js";

import { adminDashboard } from "../controllers/admin.dashboard.controller.js";
import { adminAnalytics, adminFinance, adminReconcilePending } from "../controllers/admin.analytics.controller.js";
import {
  getAdminOrganizers,
  getAdminEvents,
} from "../controllers/admin.controller.js";
import {
  getAdminAffiliates,
  toggleAdminAffiliate,
} from "../controllers/admin.affiliates.controller.js";
import { adminCancelEvent } from "../controllers/event.controller.js";

const router = express.Router();

/* ================= ADMIN DASHBOARD ================= */
router.get("/dashboard", authenticate, adminOnly, adminDashboard);

/* ================= ANALYTICS ================= */
router.get("/analytics", authenticate, adminOnly, adminAnalytics);
router.get("/finance", authenticate, adminOnly, adminFinance);
router.post("/reconcile-pending", authenticate, adminOnly, adminReconcilePending);

/* ================= ORGANIZERS ================= */
router.get("/organizers", authenticate, adminOnly, getAdminOrganizers);

/* ================= EVENTS ================= */
router.get("/events", authenticate, adminOnly, getAdminEvents);
router.patch("/events/:id/cancel", authenticate, adminOnly, adminCancelEvent);

/* ================= AFFILIATES ================= */
router.get("/affiliates", authenticate, adminOnly, getAdminAffiliates);
router.patch("/affiliates/:id/toggle", authenticate, adminOnly, toggleAdminAffiliate);

/* NOTE: /withdrawals (list, approve, reject) lives in
   admin.withdrawal.routes.js — do not redefine it here.
   A duplicate GET /withdrawals previously shadowed the real
   admin controller with the organizer-scoped one, so the
   admin panel always showed an empty list. */

export default router;
