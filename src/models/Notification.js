import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["SALE", "WITHDRAWAL", "SYSTEM"],
      default: "SYSTEM",
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    href: { type: String, default: "/organizer/dashboard", trim: true },
    readAt: { type: Date, default: null, index: true },
    dedupeKey: { type: String, trim: true },
  },
  { timestamps: true },
);

notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index(
  { recipient: 1, dedupeKey: 1 },
  { unique: true, sparse: true },
);

export default mongoose.models.Notification ||
  mongoose.model("Notification", notificationSchema);
