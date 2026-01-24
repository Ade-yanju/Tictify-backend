import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema(
  {
    reference: { type: String, unique: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: "Event" },
    email: String,
    ticketType: String,
    amount: Number,
    status: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED"],
      default: "PENDING",
    },
  },
  { timestamps: true }
);

export default mongoose.model("Transaction", transactionSchema);
