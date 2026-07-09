/* =====================================================
   AMBASSADOR COMMISSIONS
   Rate: 5% (AMBASSADOR_COMMISSION_RATE) of the PLATFORM
   FEE on each successful sale — paid from Tictify's cut,
   never the organizer's, so payouts can't exceed revenue.

   Attribution (first match wins):
   1. payment.promoter — the sale came through their ?ref= link
   2. organizer.referredBy — they onboarded the organizer

   Credits land in the ambassador's Wallet, so the existing
   withdrawal system pays them out like any organizer.
===================================================== */
import Ambassador from "../models/Ambassador.js";
import User from "../models/User.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";

const RATE = Math.min(
  1,
  Math.max(0, Number(process.env.AMBASSADOR_COMMISSION_RATE) || 0.05),
);

export async function creditAmbassadorCommission(payment) {
  try {
    if (!payment || payment.status !== "SUCCESS") return;
    const fee = Number(payment.platformFee) || 0;
    if (fee <= 0) return; // free events / recovered payments carry no fee

    /* Resolve which ambassador (if any) earns this sale */
    let code = payment.promoter;
    let source = "promoter link";
    if (!code && payment.organizer) {
      const organizer = await User.findById(payment.organizer).select("referredBy");
      if (organizer?.referredBy) {
        code = organizer.referredBy;
        source = "onboarded organizer";
      }
    }
    if (!code) return;

    const ambassador = await Ambassador.findOne({
      inviteCode: code,
      status: "APPROVED",
    });
    if (!ambassador?.user) return;

    const commission = Math.round(fee * RATE);
    if (commission <= 0) return;

    /* Idempotency: one commission per payment reference */
    const ref = `COMM-${payment.reference}`;
    const already = await WalletTransaction.findOne({ reference: ref });
    if (already) return;

    await WalletTransaction.create({
      organizer: ambassador.user,
      type: "CREDIT",
      amount: commission,
      reference: ref,
      description: `Ambassador commission (${Math.round(RATE * 100)}% of platform fee, via ${source})`,
    });

    await Wallet.updateOne(
      { organizer: ambassador.user },
      { $inc: { balance: commission, totalEarnings: commission } },
      { upsert: true },
    );

    console.log(
      `💸 Commission ₦${commission} → ${ambassador.inviteCode} (${source}, ${payment.reference})`,
    );
  } catch (err) {
    console.error("COMMISSION ERROR:", err.message);
  }
}
