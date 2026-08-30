import mongoose from "mongoose";

const feedbackSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  role: { type: String, enum: ["admin", "organizer", "ambassador", "affiliate", "guest"], default: "guest" },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  category: { type: String, enum: ["GENERAL", "BUG", "FEATURE", "PAYMENT", "OTHER"], default: "GENERAL" },
  rating: { type: Number, min: 1, max: 5 },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  status: { type: String, enum: ["NEW", "REVIEWED", "RESOLVED"], default: "NEW" },
}, { timestamps: true });

export default mongoose.model("Feedback", feedbackSchema);
