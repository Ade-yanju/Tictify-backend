import express from "express";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";

import {
  getAllWithdrawals,
} from "../controllers/admin.withdrawal.controller.js";

const router = express.Router();

/* ================= ADMIN WITHDRAWALS ================= */

router.get("/withdrawals", authenticate, authorize("admin"), getAllWithdrawals);

export default router;
