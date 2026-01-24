import express from "express";
import {
  getTicketByReference,
  getOrganizerTicketSales,
  scanTicketController,
} from "../controllers/ticket.controller.js";

import authMiddleware from "../middleware/auth.middleware.js";
import organizerOnly from "../middleware/organizer.middleware.js";

const router = express.Router();

/* Public */
router.get("/by-reference/:reference", getTicketByReference);

/* Organizer */
router.get("/sales", authMiddleware, organizerOnly, getOrganizerTicketSales);

router.post("/scan", authMiddleware, organizerOnly, scanTicketController);

export default router;
