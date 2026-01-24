import express from "express";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import { getOrganizerEventStats } from "../controllers/organizerStats.controller.js";

const router = express.Router();

router.get(
  "/events/stats",
  authenticate,
  authorize("organizer"),
  getOrganizerEventStats,
);

export default router;
