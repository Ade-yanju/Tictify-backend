import mongoose from "mongoose";

const ticketTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true }, // total available
    sold: { type: Number, default: 0 }, // 🔥 track sold tickets
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

    banner: {
      type: String,
      required: true,
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
      enum: ["DRAFT", "LIVE", "ENDED"],
      default: "DRAFT",
    },
  },
  { timestamps: true },
);

export default mongoose.model("Event", eventSchema);
