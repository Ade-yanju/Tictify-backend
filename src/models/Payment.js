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
      index: true,
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

    currency: {
      type: String,
      default: "NGN",
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
      index: true,
    },

    provider: {
      type: String,
      enum: ["FREE", "ERCASPAY"],
      default: "ERCASPAY",
    },

    paymentMethods: {
      type: [String],
      default: ["card", "bank_transfer", "ussd"],
    },

    status: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED"],
      default: "PENDING",
      index: true,
    },

    verifiedAt: {
      type: Date,
    },

    gatewayResponse: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true },
);

const Payment =
  mongoose.models.Payment || mongoose.model("Payment", paymentSchema);

export default Payment;
