import mongoose from "mongoose";

/* ── One entry per successful admit. clientScanId makes admits
   idempotent: replaying the same id (offline sync retry, dup webhook)
   is a no-op instead of a second admit or a false "already used". ── */
const admitSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    source: { type: String }, // "online" | "offline" | "bot"
    clientScanId: { type: String },
    deviceId: { type: String },
  },
  { _id: false },
);

/* ── Audit trail for ticket reissues (Feature 2). ── */
const transferSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    fromEmail: { type: String },
    toEmail: { type: String },
    toName: { type: String },
  },
  { _id: false },
);

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

    /* Idempotent per-admit log — see admitSchema above */
    admits: {
      type: [admitSchema],
      default: [],
    },

    scannedAt: {
      type: Date,
    },

    /* Holder's display name (Feature 2 transfer sets this; older
       tickets fall back to buyerEmail for display) */
    guestName: {
      type: String,
    },

    /* Reissue history (Feature 2) */
    transfers: {
      type: [transferSchema],
      default: [],
    },

    emailedAt: {
      type: Date, // set once any provider confirms delivery of the ticket email
    },
  },
  { timestamps: true },
);
ticketSchema.index({ qrCode: 1, event: 1 });

export default mongoose.model("Ticket", ticketSchema);
