import express from "express";
import { getWallet, withdraw } from "../controllers/wallet.controller.js";
import { protect } from "../middleware/auth.middleware.js"; // your existing auth middleware

const router = express.Router();

// All wallet routes are protected — organizer must be logged in
router.get("/", protect, getWallet);
router.post("/withdraw", protect, withdraw);

export default router;
