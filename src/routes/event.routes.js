import express from "express";
import {
  createEvent,
  getOrganizerEvents,
  getPublicEvents,
  getEventById,
  publishEvent,
  endEvent,
  deleteEvent,
  updateEvent
} from "../controllers/event.controller.js";

import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import { requireWhatsApp } from "../middlewares/requireWhatsApp.js";

const router = express.Router();

/* ================= CREATE =================
   Creating a NEW event requires a WhatsApp number on the account —
   that's what links the event to the bot for management and alerts.
   Editing an EXISTING event is deliberately left open so nobody is
   locked out of fixing a live event's details mid-sale. */
router.post("/", authenticate, authorize("organizer"), requireWhatsApp, createEvent);
router.put("/:id", authenticate, authorize("organizer"), updateEvent);

/* ================= ORGANIZER ================= */
router.get(
  "/organizer",
  authenticate,
  authorize("organizer"),
  getOrganizerEvents,
);

router.patch(
  "/publish/:id",
  authenticate,
  authorize("organizer"),
  publishEvent,
);

router.patch("/end/:id", authenticate, authorize("organizer"), endEvent);

/* ================= DELETE (FIXED) ================= */
router.delete("/:id", authenticate, authorize("organizer"), deleteEvent);

/* ================= PUBLIC ================= */
router.get("/", getPublicEvents);
router.get("/view/:id", getEventById);

export default router;
