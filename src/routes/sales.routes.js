// src/routes/sales.routes.js
import express from "express";
import { getOrganizerSales } from "../controllers/sales.controller.js";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get(
  "/organizer",
  authenticate,
  authorize("organizer"),
  getOrganizerSales
);

export default router;
