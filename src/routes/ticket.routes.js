import express from "express";
import rateLimit from "express-rate-limit";
import {
  getTicketByReference,
  getOrganizerTicketSales,
  scanTicketController,
  createFreeTicket,
  sendTicketViaEmail,
} from "../controllers/ticket.controller.js";

import { authenticate, authorize } from "../middlewares/auth.middleware.js";

const router = express.Router();

/* Email resend abuse protection: 10 sends / 15 min per IP */
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many email requests. Try again later." },
});

/* ========= PUBLIC ========= */
router.get("/by-reference/:reference", getTicketByReference);
router.post("/send-email", emailLimiter, sendTicketViaEmail);

/* ========= ORGANIZER ========= */
router.get(
  "/sales",
  authenticate,
  authorize("organizer"),
  getOrganizerTicketSales,
);

router.post(
  "/scan",
  authenticate,
  authorize("organizer"),
  scanTicketController,
);

/* Complimentary tickets: organizers only (was an open, unauthenticated mint) */
router.post("/free", authenticate, authorize("organizer"), createFreeTicket);

export default router;
