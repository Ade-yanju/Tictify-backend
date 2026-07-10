import mongoose from "mongoose";

const affiliateSignupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    reference: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ["PENDING", "PAID"], default: "PENDING" },
    affiliateCode: String,
  },
  { timestamps: true },
);

export default mongoose.model("AffiliateSignup", affiliateSignupSchema);
