import mongoose from "mongoose";

const ticketSchema = new mongoose.Schema(
  {
    /* ================= EXISTING (UNCHANGED) ================= */
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: true,
    },

    buyerEmail: {
      type: String,
      required: true,
    },

    qrCode: {
      type: String,
      required: true,
      unique: true,
    },

    scanned: {
      type: Boolean,
      default: false,
    },

    paymentRef: {
      type: String,
      required: true,
    },

    /* ================= NEW (NON-BREAKING) ================= */

    organizer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true, // improves sales queries
    },

    amountPaid: {
      type: Number,
      min: 0,
    },

    currency: {
      type: String,
      default: "NGN",
    },

    ticketType: {
      type: String, // e.g. Regular, VIP, Early Bird
    },
  },
  { timestamps: true },
);

export default mongoose.model("Ticket", ticketSchema);
