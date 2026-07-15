import express from "express";
import rateLimit from "express-rate-limit";
import {
  getTicketByReference,
  getOrganizerTicketSales,
  scanTicketController,
  createFreeTicket,
  sendTicketViaEmail,
  getGateStats,
  getPromoterStats,
  exportGuestList,
  emailMyTickets,
  getTicketQrImage,
  getGateManifest,
  syncGateAdmits,
  transferTicketController,
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

/* Ticket transfer abuse protection: 10 transfers / 15 min per IP */
const transferLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many transfer attempts. Try again later." },
});

/* ========= PUBLIC ========= */
router.get("/by-reference/:reference", getTicketByReference);
router.get("/qr/:reference", getTicketQrImage); // email clients block data-URIs
router.post("/send-email", emailLimiter, sendTicketViaEmail);
router.post("/my-tickets", emailLimiter, emailMyTickets);

/* Ticket transfer — ownership proven by the current holder's email in the body */
router.post("/transfer", transferLimiter, transferTicketController);

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

/* Live gate dashboard + promoter leaderboard + guest list */
router.get("/gate/:eventId", authenticate, authorize("organizer"), getGateStats);
router.get("/promoters/:eventId", authenticate, authorize("organizer"), getPromoterStats);
router.get("/export/:eventId", authenticate, authorize("organizer"), exportGuestList);

/* Offline gate: cache the manifest, replay queued admits (organizer/admin) */
router.get(
  "/gate/manifest/:eventId",
  authenticate,
  authorize("organizer", "admin"),
  getGateManifest,
);
router.post(
  "/gate/sync/:eventId",
  authenticate,
  authorize("organizer", "admin"),
  syncGateAdmits,
);

export default router;
