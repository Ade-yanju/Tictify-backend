import mongoose from "mongoose";

const feedbackSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  role: { type: String, enum: ["admin", "organizer", "ambassador", "affiliate", "guest"], default: "guest" },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  category: { type: String, enum: ["GENERAL", "BUG", "FEATURE", "PAYMENT", "OTHER"], default: "GENERAL" },
  rating: { type: Number, min: 1, max: 5 },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  // Client-generated idempotency key. A retry of the same submission must
  // return the original record instead of creating another inbox item.
  submissionKey: { type: String, trim: true, maxlength: 100, select: false },
  status: { type: String, enum: ["NEW", "REVIEWED", "RESOLVED"], default: "NEW" },
}, { timestamps: true });

feedbackSchema.index({ submissionKey: 1 }, { unique: true, sparse: true });

export default mongoose.model("Feedback", feedbackSchema);
