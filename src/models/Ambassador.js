import mongoose from "mongoose";

const ambassadorSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    university: { type: String, required: true, trim: true },
    department: { type: String, trim: true },
    level: { type: String, trim: true }, // e.g. 100L–500L
    whatsapp: { type: String, required: true, trim: true },
    socials: { type: String, trim: true }, // links, comma/newline separated
    motivation: { type: String, required: true }, // why they want to join
    organizersKnown: { type: Number, default: 0, min: 0 },
    organizationsCount: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ["APPLIED", "APPROVED", "REJECTED"],
      default: "APPLIED",
      index: true,
    },

    /* Set at approval — doubles as their promoter (?ref=) code */
    inviteCode: { type: String, uppercase: true, sparse: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    processedAt: Date,
  },
  { timestamps: true },
);

export default mongoose.model("Ambassador", ambassadorSchema);
