import mongoose from "mongoose";

const pushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: {
      type: String,
      required: true,
      unique: true,
    },

    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },

    /* What this subscriber wants:
       "events"  → new-event broadcasts (guests)
       "sales"   → ticket-sale alerts (organizer-scoped)      */
    topic: {
      type: String,
      enum: ["events", "sales"],
      default: "events",
      index: true,
    },

    organizer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true, // set for "sales" subscriptions
    },
  },
  { timestamps: true },
);

export default mongoose.model("PushSubscription", pushSubscriptionSchema);
