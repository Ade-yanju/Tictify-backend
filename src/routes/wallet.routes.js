import express from "express";
import { getWallet } from "../controllers/wallet.controller.js";
import { protect } from "../middlewares/auth.middleware.js"; // your existing auth middleware

const router = express.Router();

// All wallet routes are protected — organizer must be logged in
router.get("/", protect, getWallet);

export default router;
