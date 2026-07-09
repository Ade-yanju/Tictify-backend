import mongoose from "mongoose";

const discountCodeSchema = new mongoose.Schema(
  {
    event: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    organizer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    percentOff: { type: Number, required: true, min: 1, max: 90 },
    maxUses: { type: Number, default: 100, min: 1 },
    uses: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
discountCodeSchema.index({ event: 1, code: 1 }, { unique: true });

export default mongoose.model("DiscountCode", discountCodeSchema);
