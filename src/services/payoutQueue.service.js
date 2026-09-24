/* =====================================================
   AUTOMATIC PAYOUT QUEUE
   Makes withdrawals fully self-service: when an instant
   payout can't fire (Paystack Balance still settling — the
   T+1 gap — or a transient API failure), the withdrawal
   sits in PENDING with the organizer's funds already held.
   This sweep runs every few minutes and pays each one out
   the moment the settled balance can cover it. Admin
   dashboard is monitoring-only; queued payouts retry automatically.

   Money safety:
   - The wallet hold happened at OTP confirmation; this
     never touches wallet.balance.
   - Atomic PENDING → PROCESSING claim means concurrent workers cannot
     pay the same withdrawal twice.
   - A payout the Paystack API rejects reverts to PENDING
     for the next cycle; an async transfer.failed webhook
     refunds the wallet (webhook.controller.js).
===================================================== */

import Withdrawal from "../models/Withdrawal.js";
import {
  payoutToBank,
  paystackConfigured,
  getAvailableBalance,
  paystackTransferCharge,
} from "./paystack.service.js";
import { sendEmail } from "./emailProviders.service.js";
import { createNotification } from "./notification.service.js";

let sweeping = false;
const RETRY_DELAY_MS = 10 * 60 * 1000;

function organizerQueueEmail(withdrawal, payAmount) {
  if (!withdrawal.organizer?.email || withdrawal.organizerNotifiedAt) return null;

  return sendEmail({
    to: withdrawal.organizer.email,
    subject: "Your Tictify withdrawal is queued",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
        <h2 style="color:#0d0f16">Withdrawal queued</h2>
        <p>Hi ${withdrawal.organizer.name || "there"},</p>
        <p>Your withdrawal of <strong>₦${payAmount.toLocaleString()}</strong> has been confirmed and is queued for processing.</p>
        <p>Your funds are reserved and the payout will continue automatically. Settlement can sometimes take longer than usual, but you do not need to submit another request.</p>
      </div>`,
  });
}

export async function processPendingPayouts() {
  if (sweeping) return; // a slow sweep must not overlap the next tick
  if (!paystackConfigured)
    return;

  sweeping = true;
  try {
    const pending = await Withdrawal.find({
      status: "PENDING",
      "bankDetails.accountNumber": { $exists: true, $ne: "" },
      "bankDetails.bankCode": { $exists: true, $ne: "" },
      $or: [
        { nextAttemptAt: { $exists: false } },
        { nextAttemptAt: null },
        { nextAttemptAt: { $lte: new Date() } },
      ],
    })
      .sort("createdAt") // oldest first — first requested, first paid
      .populate("organizer", "name email");

    if (pending.length === 0) return;

    let balance = await getAvailableBalance();
    if (balance == null) return; // API hiccup — next cycle will retry

    for (const w of pending) {
      const payAmount = w.netAmount ?? w.amount;
      const needed = payAmount + paystackTransferCharge(payAmount);
      if (balance < needed) {
        /* Keep this diagnostic private. The organizer only receives a calm,
           actionable message that the withdrawal is queued automatically. */
        w.failureCode = "PAYSTACK_BALANCE_LOW";
        w.failureReason = "Settled payout capacity is below this request.";
        w.nextAttemptAt = new Date(Date.now() + RETRY_DELAY_MS);
        const notice = organizerQueueEmail(w, payAmount);
        await w.save();
        if (notice) {
          notice
            .then((result) => {
              if (result?.success) {
                return Withdrawal.updateOne(
                  { _id: w._id },
                  { $set: { organizerNotifiedAt: new Date() } },
                );
              }
              return null;
            })
            .catch((e) =>
              console.error("Queued payout email failed:", e?.message || e),
            );
        }
        continue; // still settling — smaller ones may fit
      }

      /* Atomic claim — loses gracefully if an admin approved it first */
      const claimed = await Withdrawal.findOneAndUpdate(
        { _id: w._id, status: "PENDING" },
        {
          status: "PROCESSING",
          approvedAt: new Date(),
          lastAttemptAt: new Date(),
        },
        { new: true },
      );
      if (!claimed) continue;

      try {
        const payout = await payoutToBank({
          amount: payAmount,
          bankDetails: w.bankDetails,
          reason: `Tictify payout — ${w.bankDetails.accountName}`,
          reference: `wd_${w._id}`,
          recipientCode: w.paystackRecipientCode,
        });

        claimed.status = "PROCESSING";
        claimed.paystackReference = payout.reference;
        claimed.paystackTransferCode = payout.transferCode;
        claimed.paystackTransferStatus = payout.status;
        claimed.paystackRecipientCode = payout.recipientCode;
        claimed.failureReason = undefined;
        claimed.failureCode = undefined;
        claimed.nextAttemptAt = undefined;
        await claimed.save();
        createNotification({
          recipientId: claimed.organizer,
          type: "WITHDRAWAL",
          title: "Withdrawal processing",
          message: "Your withdrawal has been sent for processing.",
          href: "/organizer/withdraw",
          dedupeKey: "withdrawal:" + String(claimed._id) + ":PROCESSING",
        }).catch((e) => console.error("WITHDRAWAL NOTIFICATION ERROR:", e.message));

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
        claimed.failureCode = err.category || "TRANSIENT";
        claimed.failureReason = err.message;
        claimed.lastAttemptAt = new Date();
        claimed.nextAttemptAt = new Date(Date.now() + RETRY_DELAY_MS);
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
