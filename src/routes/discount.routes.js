import express from "express";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";
import {
  createDiscount,
  listDiscounts,
  toggleDiscount,
} from "../controllers/discount.controller.js";

const router = express.Router();
router.post("/", authenticate, authorize("organizer"), createDiscount);
router.get("/event/:eventId", authenticate, authorize("organizer"), listDiscounts);
router.patch("/:id/toggle", authenticate, authorize("organizer"), toggleDiscount);
export default router;
