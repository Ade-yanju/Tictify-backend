import express from "express";
import { authenticate, authorize } from "../middlewares/auth.middleware.js";

import {
  getAllWithdrawals,
  rejectWithdrawal,
} from "../controllers/admin.withdrawal.controller.js";

const router = express.Router();

/* ================= ADMIN WITHDRAWALS ================= */

router.get("/withdrawals", authenticate, authorize("admin"), getAllWithdrawals);


router.patch(
  "/withdrawals/:id/reject",
  authenticate,
  authorize("admin"),
  rejectWithdrawal,
);

export default router;
