/* =====================================================
   AUTOMATIC PAYOUT QUEUE
   Makes withdrawals fully self-service: when an instant
   payout can't fire (Paystack Balance still settling — the
   T+1 gap — or a transient API failure), the withdrawal
   sits in PENDING with the organizer's funds already held.
   This sweep runs every few minutes and pays each one out
   the moment the settled balance can cover it. Admin
   approval remains as a manual override only.

   Money safety:
   - The wallet hold happened at OTP confirmation; this
     never touches wallet.balance.
   - Atomic PENDING → APPROVED claim means the sweep and an
     admin can never both pay the same withdrawal.
   - A payout the Paystack API rejects reverts to PENDING
     for the next cycle; an async transfer.failed webhook
     refunds the wallet (webhook.controller.js).
===================================================== */

import Withdrawal from "../models/Withdrawal.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";
import {
  payoutToBank,
  paystackConfigured,
  getAvailableBalance,
  paystackTransferCharge,
} from "./paystack.service.js";
import { sendEmail } from "./emailProviders.service.js";

let sweeping = false;

export async function processPendingPayouts() {
  if (sweeping) return; // a slow sweep must not overlap the next tick
  if (!paystackConfigured || process.env.AUTO_APPROVE_WITHDRAWALS !== "true")
    return;

  sweeping = true;
  try {
    const pending = await Withdrawal.find({
      status: "PENDING",
      "bankDetails.accountNumber": { $exists: true, $ne: "" },
      "bankDetails.bankCode": { $exists: true, $ne: "" },
    })
      .sort("createdAt") // oldest first — first requested, first paid
      .populate("organizer", "name email");

    if (pending.length === 0) return;

    let balance = await getAvailableBalance();
    if (balance == null) return; // API hiccup — next cycle will retry

    for (const w of pending) {
      const payAmount = w.netAmount ?? w.amount;
      const needed = payAmount + paystackTransferCharge(payAmount);
      if (balance < needed) continue; // still settling — smaller ones may fit

      /* Atomic claim — loses gracefully if an admin approved it first */
      const claimed = await Withdrawal.findOneAndUpdate(
        { _id: w._id, status: "PENDING" },
        { status: "APPROVED", approvedAt: new Date() },
        { new: true },
      );
      if (!claimed) continue;

      try {
        const payout = await payoutToBank({
          amount: payAmount,
          bankDetails: w.bankDetails,
          reason: `Tictify payout — ${w.bankDetails.accountName}`,
        });

        claimed.status = "PAID";
        claimed.paystackReference = payout.reference;
        claimed.failureReason = undefined;
        await claimed.save();

        await Wallet.updateOne(
          { organizer: claimed.organizer },
          { $inc: { totalWithdrawn: claimed.amount } },
        );
        await WalletTransaction.create({
          organizer: claimed.organizer,
          type: "DEBIT",
          amount: claimed.amount,
          reference: payout.reference,
          description: "Automatic payout via Paystack",
        });

        balance -= needed;
        console.log(
          `✅ Auto-payout: ₦${payAmount.toLocaleString()} → ····${w.bankDetails.accountNumber.slice(-4)} (${payout.reference})`,
        );

        if (w.organizer?.email) {
          sendEmail({
            to: w.organizer.email,
            subject: "Your Tictify payout is on the way 🎉",
            html: `
              <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
                <h2 style="color:#0d0f16">Payout sent</h2>
                <p>Hi ${w.organizer.name || "there"},</p>
                <p><strong>₦${payAmount.toLocaleString()}</strong> is on its way to
                ${w.bankDetails.bankName || "your bank"} ····${w.bankDetails.accountNumber.slice(-4)}.</p>
                <p style="color:#666;font-size:13px">Reference: ${payout.reference}<br/>
                Banks usually credit within minutes. Questions? Reply to tictify@gmail.com.</p>
              </div>`,
          }).catch((e) =>
            console.error("Payout email failed:", e?.message || e),
          );
        }
      } catch (err) {
        /* Paystack rejected the transfer — back to the queue.
           failureReason is shown to admins and keeps the last cause. */
        claimed.status = "PENDING";
        claimed.approvedAt = undefined;
        claimed.failureReason = err.message;
        await claimed.save();
        console.error(
          `⏳ Auto-payout retry failed (will retry): ${err.message}`,
        );
      }
    }
  } catch (err) {
    console.error("PAYOUT SWEEP ERROR:", err);
  } finally {
    sweeping = false;
  }
}
