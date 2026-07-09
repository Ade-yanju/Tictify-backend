import express from "express";
import rateLimit from "express-rate-limit";
import {
  applyAmbassador,
  adminListAmbassadors,
  adminApproveAmbassador,
  adminRejectAmbassador,
  ambassadorDashboard,
} from "../controllers/ambassador.controller.js";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";

const router = express.Router();

/* Application spam protection: 5 applications / hour per IP */
const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many applications from this network. Try again later." },
});

/* ── PUBLIC: the /campusambassadors form posts here ── */
router.post("/apply", applyLimiter, applyAmbassador);

/* ── AMBASSADOR: their dashboard (invite code + stats) ── */
router.get("/me", authenticate, authorize("ambassador"), ambassadorDashboard);

/* ── ADMIN: review pipeline ── */
router.get("/", authenticate, authorize("admin"), adminListAmbassadors);
router.patch("/:id/approve", authenticate, authorize("admin"), adminApproveAmbassador);
router.patch("/:id/reject", authenticate, authorize("admin"), adminRejectAmbassador);

export default router;
