import express from "express";
import {
  getTicketByReference,
  getOrganizerTicketSales,
  scanTicketController,
} from "../controllers/ticket.controller.js";

import { authenticate, authorize } from "../middlewares/auth.middleware.js";

const router = express.Router();

/* ========= PUBLIC ========= */
router.get("/by-reference/:reference", getTicketByReference);

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

router.post("/free", createFreeTicket);

export default router;
