/* =====================================================
   PAYSTACK PAYOUTS
   One place for transfer logic — used by both the admin
   approval flow and the auto-payout flow.

   NOTE: Paystack transfers are ASYNC. The API accepting a
   transfer does NOT mean the money moved — the final word
   arrives via the transfer.success / transfer.failed /
   transfer.reversed webhook events (handled in
   webhook.controller.js).
===================================================== */

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

export const paystackConfigured = Boolean(
  PAYSTACK_SECRET_KEY && PAYSTACK_SECRET_KEY.startsWith("sk_"),
);

/* Create (or reuse) a transfer recipient, then fire the transfer.
   Returns { reference, transferCode, status } or throws with a
   human-readable message. */
export async function payoutToBank({ amount, bankDetails, reason }) {
  if (!paystackConfigured) {
    throw new Error("Paystack is not configured");
  }

  const headers = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  };

  /* 1. Recipient */
  const recipientRes = await fetch(
    "https://api.paystack.co/transferrecipient",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "nuban",
        name: bankDetails.accountName,
        account_number: bankDetails.accountNumber,
        bank_code: bankDetails.bankCode,
        currency: "NGN",
      }),
    },
  );
  const recipient = await recipientRes.json();
  if (!recipient.status) {
    throw new Error(recipient.message || "Bank account could not be verified");
  }

  /* 2. Transfer (amount in kobo) */
  const transferRes = await fetch("https://api.paystack.co/transfer", {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "balance",
      amount: Math.round(amount * 100),
      recipient: recipient.data.recipient_code,
      reason: reason || "Tictify payout",
    }),
  });
  const transfer = await transferRes.json();
  if (!transfer.status) {
    // Common causes: transfers not enabled, insufficient Paystack balance,
    // OTP required on transfers (must be disabled for automation)
    throw new Error(transfer.message || "Transfer failed");
  }

  return {
    reference: transfer.data.reference,
    transferCode: transfer.data.transfer_code,
    status: transfer.data.status, // "pending" | "success" | "otp" ...
  };
}
