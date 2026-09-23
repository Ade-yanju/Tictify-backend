import express from "express";
import rateLimit from "express-rate-limit";
import {
  initiateInstallment,
  getInstallmentPlan,
  payInstallment,
  getOrganizerInstallments,
  getAdminInstallments,
} from "../controllers/installment.controller.js";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import { adminOnly } from "../middlewares/admin.middleware.js";

const router = express.Router();

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many installment requests. Try again later." },
});

router.post("/initiate", publicLimiter, initiateInstallment);
router.get(
  "/organizer/list",
  authenticate,
  authorize("organizer"),
  getOrganizerInstallments,
);
router.get(
  "/admin/list",
  authenticate,
  adminOnly,
  getAdminInstallments,
);
router.get("/:token", publicLimiter, getInstallmentPlan);
router.post("/:token/pay", publicLimiter, payInstallment);

export default router;
