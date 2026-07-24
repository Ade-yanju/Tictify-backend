import mongoose from "mongoose";

const ticketTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true }, // total available
    sold: { type: Number, default: 0 }, // 🔥 track sold tickets
    groupSize: { type: Number, default: 1, min: 1 }, // people admitted per ticket (e.g. Group of Friends x4)
    earlyBirdPrice: { type: Number, min: 0 }, // optional cheaper price...
    earlyBirdUntil: { type: Date }, // ...until this moment
  },
  { _id: false },
);

const eventSchema = new mongoose.Schema(
  {
    organizer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    title: { type: String, required: true },

    /* Human-readable URL key: slugify(title) + "-" + last 8 chars of
       _id (see utils/resolveEvent.js). Not unique and not required —
       the id suffix already guarantees uniqueness, and every lookup
       falls back to the _id so pre-slug links never break. */
    slug: { type: String, index: true },

    description: { type: String, required: true },
    location: { type: String, required: true },

    // ⏰ EVENT TIMING
    date: {
      type: Date,
      required: true, // START TIME (keep name to avoid breaking frontend)
    },

    endDate: {
      type: Date,
      required: true, // 🔥 NEW: EVENT END TIME
    },

    /* When ticket sales stop. Optional — when unset, sales run right up
       to endDate (so organizers can sell at the door). Never read
       directly: use salesCloseAt(event) so the fallback always applies. */
    salesEndAt: { type: Date },

    banner: {
      type: String,
      required: true,
    },

    /* How the banner displays: "cover" fills the frame (crops the
       edges), "contain" shows the whole flyer on a blurred backdrop */
    bannerFit: {
      type: String,
      enum: ["cover", "contain"],
      default: "cover",
    },

    capacity: {
      type: Number,
      required: true,
    },

    ticketTypes: {
      type: [ticketTypeSchema],
      required: true,
    },

    status: {
      type: String,
      enum: ["DRAFT", "LIVE", "ENDED", "CANCELLED"],
      default: "DRAFT",
    },

    /* Discovery: "what's happening this weekend?" */
    category: {
      type: String,
      enum: [
        "Nightlife",
        "Comedy",
        "Concert",
        "Sports",
        "Workshop",
        "Festival",
        "Campus",
        "Other",
      ],
      default: "Other",
      index: true,
    },

    city: { type: String, trim: true, index: true },

    /* Affiliates: organizer opts in and sets the cut (% of ticket
       price, paid from the organizer's revenue) */
    affiliatesEnabled: { type: Boolean, default: false },
    affiliatePercent: { type: Number, min: 1, max: 50, default: 15 },

    cancelledAt: Date,
    cancelReason: String,
  },
  { timestamps: true },
);

export default mongoose.model("Event", eventSchema);
