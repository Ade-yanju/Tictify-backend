import mongoose from "mongoose";

const ticketTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
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
    date: { type: Date, required: true },

    banner: {
      type: String, // ImgBB URL
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
