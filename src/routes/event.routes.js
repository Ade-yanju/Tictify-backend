import express from "express";
import {
  createEvent,
  getOrganizerEvents,
  getPublicEvents,
  getEventById,
  publishEvent,
  endEvent,
} from "../controllers/event.controller.js";

import { authenticate, authorize } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/", authenticate, authorize("organizer"), createEvent);

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

router.get("/", getPublicEvents);
router.get("/view/:id", getEventById);
router.delete(
  "/events/:id",
  authenticate,
  authorize("organizer"),
  deleteEvent,
);


export default router;
