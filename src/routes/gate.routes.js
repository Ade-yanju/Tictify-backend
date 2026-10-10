import express from "express";
import rateLimit from "express-rate-limit";
import {
  gateStaffLogin,
  getGateLoginEvent,
} from "../controllers/gateStaff.controller.js";

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many scanner login attempts. Try again later." },
});

router.get("/event/:eventId", getGateLoginEvent);
router.post("/login", loginLimiter, gateStaffLogin);

export default router;
