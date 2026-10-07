import Withdrawal from "../models/Withdrawal.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";
import mongoose from "mongoose";
import { createNotification } from "../services/notification.service.js";


/* ================= GET ALL WITHDRAWALS ================= */
export const getAllWithdrawals = async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find()
      .populate("organizer", "name email")
      .populate("processedBy", "name email")
      .sort("-createdAt");

    res.json(withdrawals.map((withdrawal) => { const item = withdrawal.toObject(); item.status = item.status === "APPROVED" ? "PROCESSING" : item.status === "PAID" ? "SUCCESS" : item.status; return item; }));
  } catch (err) {
    console.error("ADMIN WITHDRAWALS ERROR:", err);
    res.status(500).json({ message: "Failed to load withdrawals" });
  }
};

/*
 * A queued payout is still held in the organizer wallet. Rejection is an
 * atomic state claim: only a withdrawal that is still PENDING can be
 * rejected. PROCESSING is already in flight with Paystack and must be
 * resolved by the provider webhook instead.
 */
export const rejectWithdrawal = async (req, res) => {
  let session;
  try {
    const reason = String(req.body?.reason || "Rejected by administrator")
      .trim()
      .slice(0, 240);

    // Keep the state transition, wallet refund and ledger row in one MongoDB
    // transaction. If any part fails, the withdrawal remains PENDING and the
    // automatic queue can retry it safely.
    session = await mongoose.startSession();
    let withdrawal;
    await session.withTransaction(async () => {
      withdrawal = await Withdrawal.findOneAndUpdate(
        { _id: req.params.id, status: "PENDING" },
        {
          $set: {
            status: "REJECTED",
            failedAt: new Date(),
            failureCode: "ADMIN_REJECTED",
            failureReason: reason,
            processedBy: req.user._id,
          },
        },
        { new: true, session },
      );

      if (!withdrawal) {
        const existing = await Withdrawal.findById(req.params.id).select("status").session(session);
        const stateError = new Error(
          !existing
            ? "Withdrawal not found"
            : existing.status === "PROCESSING"
              ? "This withdrawal is already being sent to the bank and cannot be rejected."
              : "This withdrawal is already resolved and cannot be rejected.",
        );
        stateError.httpStatus = existing ? 409 : 404;
        throw stateError;
      }

      await Wallet.findOneAndUpdate(
        { organizer: withdrawal.organizer },
        { $inc: { balance: withdrawal.amount } },
        { upsert: true, new: true, setDefaultsOnInsert: true, session },
      );

      await WalletTransaction.create([{
        organizer: withdrawal.organizer,
        type: "CREDIT",
        amount: withdrawal.amount,
        reference: `WD-ADMIN-REFUND-${withdrawal._id}`,
        description: "Withdrawal rejected by admin — held funds returned to wallet",
      }], { session });
    });
    await session.endSession();
    session = null;

    await createNotification({
      recipientId: withdrawal.organizer,
      type: "WITHDRAWAL",
      title: "Withdrawal rejected",
      message: `Your queued withdrawal of ₦${withdrawal.amount.toLocaleString()} was rejected and the funds have been returned to your wallet.`,
      href: "/organizer/withdraw",
      dedupeKey: `withdrawal:${withdrawal._id}:REJECTED`,
    }).catch((notificationError) => {
      // The money transition is already committed; a notification outage
      // must not make the admin repeat a successful rejection.
      console.error("WITHDRAWAL REJECTION NOTIFICATION ERROR:", notificationError);
    });

    return res.json({
      message: "Withdrawal rejected and held funds returned to the organizer wallet",
      withdrawal,
    });
  } catch (err) {
    if (session) await session.endSession().catch(() => {});
    if (err.httpStatus) return res.status(err.httpStatus).json({ message: err.message });
    console.error("ADMIN WITHDRAWAL REJECTION ERROR:", err);
    res.status(500).json({ message: "Could not reject withdrawal" });
  }
};
