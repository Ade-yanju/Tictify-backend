import express from "express";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import {
  getOrganizerTicketSales,
  getTicketByReference,
} from "../controllers/ticket.controller.js";

import { scanTicket } from "../controllers/ticket.scan.controller.js";
const router = express.Router();

/* ================= ORGANIZER ================= */

// Ticket sales dashboard
router.get(
  "/sales/organizer",
  authenticate,
  authorize("organizer"),
  getOrganizerTicketSales,
);
// routes/ticket.routes.js
router.get("/by-reference/:reference", getTicketByReference);

router.post("/scan", authenticate, authorize("organizer"), scanTicket);

export default router;
