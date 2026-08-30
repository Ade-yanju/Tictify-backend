import express from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { adminOnly } from "../middlewares/admin.middleware.js";
import { submitFeedback, listFeedback, updateFeedback } from "../controllers/feedback.controller.js";

const router = express.Router();
router.post("/", authenticate, submitFeedback);
router.get("/admin", authenticate, adminOnly, listFeedback);
router.patch("/admin/:id", authenticate, adminOnly, updateFeedback);
export default router;
