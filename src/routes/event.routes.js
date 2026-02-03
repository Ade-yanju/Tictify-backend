import express from "express";
import {
  createEvent,
  getOrganizerEvents,
  getPublicEvents,
  getEventById,
  publishEvent,
  endEvent,
  deleteEvent,
} from "../controllers/event.controller.js";

import { authenticate, authorize } from "../middlewares/auth.middleware.js";

const router = express.Router();

/* ================= CREATE ================= */
router.post("/", authenticate, authorize("organizer"), createEvent);

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
