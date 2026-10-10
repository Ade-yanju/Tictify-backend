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
  , duplicateEvent
} from "../controllers/event.controller.js";

import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import { requireWhatsApp } from "../middlewares/requireWhatsApp.js";
import { getEventTemplates } from "../controllers/eventTemplates.controller.js";
import {
  getCohostInvite,
  inviteCohost,
  listCohosts,
  regenerateInviteLink,
  acceptCohostInvite,
  generateCohostSalesLink,
  revokeCohost,
} from "../controllers/eventCohost.controller.js";
import {
  listGateStaff,
  createGateStaff,
  revokeGateStaff,
} from "../controllers/gateStaff.controller.js";

const router = express.Router();
router.get("/templates", getEventTemplates);

/* Co-host invitation links are intentionally token-based and store only hashes. */
router.get("/cohosts/invite/:token", getCohostInvite);
router.post("/cohosts/invite/:token/accept", authenticate, authorize("organizer"), acceptCohostInvite);

/* ================= CREATE =================
   Creating a NEW event requires a WhatsApp number on the account —
   that's what links the event to the bot for management and alerts.
   Editing an EXISTING event is deliberately left open so nobody is
   locked out of fixing a live event's details mid-sale. */
router.post("/", authenticate, authorize("organizer"), requireWhatsApp, createEvent);
router.put("/:id", authenticate, authorize("organizer"), updateEvent);
router.post("/duplicate/:id", authenticate, authorize("organizer"), duplicateEvent);

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

router.get("/:id/cohosts", authenticate, authorize("organizer"), listCohosts);
router.post("/:id/cohosts/invite", authenticate, authorize("organizer"), inviteCohost);
router.post("/:id/cohosts/:cohostId/invite-link", authenticate, authorize("organizer"), regenerateInviteLink);
router.post("/:id/cohosts/:cohostId/sales-link", authenticate, authorize("organizer"), generateCohostSalesLink);
router.delete("/:id/cohosts/:cohostId", authenticate, authorize("organizer"), revokeCohost);

router.get("/:id/gate-staff", authenticate, authorize("organizer"), listGateStaff);
router.post("/:id/gate-staff", authenticate, authorize("organizer"), createGateStaff);
router.delete("/:id/gate-staff/:staffId", authenticate, authorize("organizer"), revokeGateStaff);

/* ================= DELETE (FIXED) ================= */
router.delete("/:id", authenticate, authorize("organizer"), deleteEvent);

/* ================= PUBLIC ================= */
router.get("/", getPublicEvents);
router.get("/view/:id", getEventById);

export default router;
