import express from "express";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";
import { organizerDashboard } from "../controllers/dashboard.controller.js";

const router = express.Router();

/**
 * Organizer dashboard
 * GET /api/dashboard/organizer
 */
router.get(
  "/organizer",
  requireAuth,
  requireRole("organizer"),
  organizerDashboard
);

export default router;
