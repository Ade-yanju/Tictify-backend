import express from "express";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import { getOrganizerEventStats, getOrganizerReferrals } from "../controllers/organizerStats.controller.js";

const router = express.Router();

router.get(
  "/events/stats",
  authenticate,
  authorize("organizer"),
  getOrganizerEventStats,
);
router.get("/referrals", authenticate, authorize("organizer"), getOrganizerReferrals);

export default router;
