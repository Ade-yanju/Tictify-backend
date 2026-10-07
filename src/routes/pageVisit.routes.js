import express from "express";
import rateLimit from "express-rate-limit";
import { recordPageVisit } from "../controllers/pageVisit.controller.js";

const router = express.Router();
const pageVisitLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/", pageVisitLimiter, recordPageVisit);

export default router;
