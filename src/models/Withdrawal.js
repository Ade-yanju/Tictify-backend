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
      enum: ["PENDING", "APPROVED", "REJECTED", "PAID", "FAILED"],
      default: "PENDING",
    },

    failureReason: String, // set when Paystack reports transfer.failed/reversed

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
