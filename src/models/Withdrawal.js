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
      type: Number,
      required: true,
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
