import mongoose from "mongoose";

/* One conversation state per WhatsApp number.
   NOTE: deliberately NO Mongo TTL index — a TTL delete would also
   wipe the permanent organizerUser link. Staleness is handled in
   code instead: the bot resets `state`/`data` to the main menu when
   updatedAt is older than 24h, keeping the account link intact. */
const whatsAppSessionSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    /* Conversation state machine: MENU, BROWSING, PICK_TIER, QTY,
       NAME, EMAIL, TICKETS_EMAIL, ORG_EMAIL, ORG_OTP, ORG_MENU */
    state: {
      type: String,
      default: "MENU",
    },

    /* Flow scratch space (eventIds, tierNames, qty, name, …) */
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    /* Set after the organizer proves email ownership via OTP —
       survives session staleness resets. */
    organizerUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    /* Affiliate link — separate from organizerUser so one phone can
       be both an organizer and an affiliate at the same time. */
    affiliateUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    /* Account-linking OTP — same sha256 discipline as withdrawals:
       6 digits, 10-minute expiry, 5 attempts. */
    otpHash: String,
    otpExpires: Date,
    otpAttempts: { type: Number, default: 0 },
  },
  { timestamps: true, minimize: false },
);

export default mongoose.models.WhatsAppSession ||
  mongoose.model("WhatsAppSession", whatsAppSessionSchema);
