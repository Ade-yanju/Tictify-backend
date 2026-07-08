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
      unique: true, // ✅ REQUIRED
      index: true,
    },

    qrImage: {
      type: String,
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
      type: String, // e.g. Regular, VIP, Early Bird, Group of Friends
    },

    /* ── Group admission: one ticket can admit several guests ── */
    groupSize: {
      type: Number,
      default: 1,
      min: 1,
    },

    admittedCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    scannedAt: {
      type: Date,
    },
  },
  { timestamps: true },
);
ticketSchema.index({ qrCode: 1, event: 1 });

export default mongoose.model("Ticket", ticketSchema);
