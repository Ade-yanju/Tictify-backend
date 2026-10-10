import mongoose from "mongoose";

/*
 * Gate staff are deliberately not User documents.  They cannot log in to the
 * organiser workspace and their credentials are scoped to one event.
 */
const gateStaffSchema = new mongoose.Schema(
  {
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    organizer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    isActive: { type: Boolean, default: true, index: true },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

gateStaffSchema.index({ event: 1, email: 1 }, { unique: true });

export default mongoose.model("GateStaff", gateStaffSchema);
