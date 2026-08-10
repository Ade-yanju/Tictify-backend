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

    /* WhatsApp number — digits only, country code, no "+" (see
       utils/phone.js normalizeWhatsApp). This is how an organizer is
       matched to the handset messaging the bot, so the format MUST be
       canonical on every write path.

       Deliberately NOT `required` and NOT `unique` at the schema level:
       every pre-existing organizer document lacks the field, so a
       required field would break their next .save(), and a unique index
       over many missing values is exactly where sparse-vs-unique bites.
       Mandatory-ness and uniqueness are enforced at the API boundary
       (register, PATCH /auth/me, bot signup) where a real error message
       can be returned. */
    whatsapp: { type: String, trim: true, index: true, sparse: true },

    /* Set only when ownership of the handset is PROVEN — i.e. the
       number linked itself through the bot's OTP flow, or the account
       was created from that handset. A number typed into a web form is
       stored but stays unverified. */
    whatsappVerifiedAt: Date,

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
