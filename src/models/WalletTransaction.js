import mongoose from "mongoose";

const walletTransactionSchema = new mongoose.Schema(
  {
    organizer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: ["CREDIT", "DEBIT"],
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    reference: {
      type: String,
      required: true,
    },

    description: {
      type: String,
    },
  },
  { timestamps: true },
);

export default mongoose.model("WalletTransaction", walletTransactionSchema);
