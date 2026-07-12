// src/models/Withdrawal.js
import mongoose from "mongoose";

const withdrawalSchema = new mongoose.Schema(
  {
    organizer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    amount: {
      type: Number, // amount deducted from the wallet
      required: true,
    },

    transferFee: {
      type: Number, // Paystack transfer fee — borne by the organizer
      default: 0,
    },

    netAmount: {
      type: Number, // what actually lands in the organizer's bank
    },

    status: {
      type: String,
      enum: ["AWAITING_OTP", "PENDING", "APPROVED", "REJECTED", "PAID", "FAILED", "EXPIRED"],
      default: "PENDING",
    },

    failureReason: String,

    /* Withdrawal confirmation (anti-fraud): a 6-digit code emailed to
       the ACCOUNT email must be entered before any money moves */
    otpHash: String,
    otpExpires: Date,
    otpAttempts: { type: Number, default: 0 }, // set when Paystack reports transfer.failed/reversed

    bankDetails: {
      bankName: String,
      bankCode: String, // required for Paystack payouts — was silently dropped
      accountNumber: String,
      accountName: String,
    },
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // admin
    },
    approvedAt: Date,
    paystackReference: String,
  },
  { timestamps: true },
);

export default mongoose.model("Withdrawal", withdrawalSchema);
