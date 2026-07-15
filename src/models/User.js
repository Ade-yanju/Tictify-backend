import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
    },

    passwordHash: { type: String, required: true },

    role: {
      type: String,
      enum: ["admin", "organizer", "ambassador", "affiliate"],
      default: "organizer",
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    /* Affiliate: their personal promo code (?ref=) */
    affiliateCode: { type: String, uppercase: true, sparse: true, unique: true },

    /* Ambassador invite code that referred this organizer (optional) */
    referredBy: { type: String, uppercase: true, trim: true, index: true },

    /* Password reset (forgot-password flow) */
    resetTokenHash: String,
    resetTokenExp: Date,

    /* Email verification (OTP at signup). Default TRUE so every
       existing account is grandfathered — only accounts explicitly
       created with emailVerified:false are gated at login. */
    emailVerified: { type: Boolean, default: true },
    verifyOtpHash: String,
    verifyOtpExpires: Date,
    verifyOtpAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
