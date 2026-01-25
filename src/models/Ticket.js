import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: true,
    },

    organizer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    email: {
      type: String,
      required: true,
    },

    ticketType: {
      type: String,
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    platformFee: {
      type: Number,
      default: 0,
    },

    organizerAmount: {
      type: Number,
      default: 0,
    },

    reference: {
      type: String,
      unique: true,
      required: true,
    },

    provider: {
      type: String,
      enum: ["MOCK", "ERCASPAY", "PAYSTACK"],
      default: "MOCK",
    },

    status: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED"],
      default: "PENDING",
    },
  },
  { timestamps: true },
);

export default mongoose.model("Payment", paymentSchema);
