import mongoose from "mongoose";

const pageVisitSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true },
    path: { type: String, required: true, trim: true, maxlength: 200, index: true },
    ip: { type: String, required: true, trim: true, maxlength: 64, index: true },
    visits: { type: Number, required: true, default: 0, min: 0 },
    lastVisitedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

pageVisitSchema.index({ date: 1, path: 1, ip: 1 }, { unique: true });

export default mongoose.models.PageVisit || mongoose.model("PageVisit", pageVisitSchema);
