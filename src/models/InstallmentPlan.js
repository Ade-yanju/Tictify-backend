import mongoose from "mongoose";

const installmentPlanSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    eventTitle: { type: String, default: "" },
    organizer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    // Set for WhatsApp-originated reservations so payment updates and the
    // completed QR can be delivered back to the same chat.
    waPhone: { type: String, trim: true },
    ticketType: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    groupSize: { type: Number, default: 1, min: 1 },
    promoter: { type: String, trim: true, index: true },

    unitPrice: { type: Number, required: true, min: 0 },
    discountCode: { type: String, uppercase: true, trim: true },
    discountAmount: { type: Number, default: 0, min: 0 },
    ticketSubtotal: { type: Number, required: true, min: 0 },
    platformFee: { type: Number, default: 0, min: 0 },
    principalDue: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, default: 0, min: 0 },
    amountRemaining: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: ["RESERVED", "PARTIALLY_PAID", "PAID", "EXPIRED", "CANCELLED", "REFUNDED"],
      default: "RESERVED",
      index: true,
    },
    dueAt: { type: Date, required: true, index: true },
    lastPaymentAt: Date,
    completedAt: Date,
    expiredAt: Date,
    reservationReleasedAt: Date,
    reminder24hSentAt: Date,
    reminderDueSentAt: Date,
    refundStatus: {
      type: String,
      enum: ["NOT_REQUIRED", "PENDING", "PARTIAL", "COMPLETED"],
      default: "NOT_REQUIRED",
      index: true,
    },
    refundAttempts: { type: Number, default: 0, min: 0 },
    refundStartedAt: Date,
    refundedAt: Date,
    refundedAmount: { type: Number, default: 0, min: 0 },
    refundError: String,
    refundEmailSentAt: Date,

    accessTokenHash: { type: String, required: true, unique: true, index: true, select: false },
    accessToken: { type: String, required: true, select: false },
    paymentCount: { type: Number, default: 0, min: 0 },
    lastPaymentReference: { type: String },
  },
  { timestamps: true },
);

export default mongoose.models.InstallmentPlan ||
  mongoose.model("InstallmentPlan", installmentPlanSchema);
