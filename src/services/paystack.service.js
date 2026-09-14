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
const PAYSTACK_API = "https://api.paystack.co";

export const paystackConfigured = Boolean(
  PAYSTACK_SECRET_KEY && PAYSTACK_SECRET_KEY.startsWith("sk_"),
);

function paystackHeaders() {
  return { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` };
}

/* Keep dashboard calls bounded. A temporary Paystack outage should not make
   the whole admin dashboard hang indefinitely. */
async function paystackGet(path, query = {}) {
  const url = new URL(`${PAYSTACK_API}${path}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value != null) url.searchParams.set(key, String(value));
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(url, {
      headers: paystackHeaders(),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.status) {
      throw new Error(body.message || `Paystack request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

/* Withdrawal fee — flat ₦100 charged to the withdrawer:
   ₦50 stamp duty + ₦50 platform/maintenance fee.
   (Covers Paystack's ₦10-₦50 transfer cost; the rest is margin.)
   Example: withdraw ₦25,000 → bank receives ₦24,900, wallet → ₦0. */
export const STAMP_DUTY = 50;
export const PLATFORM_WITHDRAWAL_FEE = 50;
export function transferFee() {
  return STAMP_DUTY + PLATFORM_WITHDRAWAL_FEE; // ₦100 flat
}

/* What Paystack charges US to send a transfer (their published NGN bands).
   Needed to know if the Paystack Balance can really cover a payout. */
export function paystackTransferCharge(amount) {
  if (amount <= 5000) return 10;
  if (amount <= 50000) return 25;
  return 50;
}

/* Available (settled) NGN balance in naira, or null if the check failed.
   Transfers can only spend this — money still settling doesn't count. */
export async function getAvailableBalance() {
  if (!paystackConfigured) return null;
  try {
    const body = await paystackGet("/balance");
    const ngn = (body.data || []).find((b) => b.currency === "NGN");
    return ngn ? ngn.balance / 100 : null;
  } catch {
    return null;
  }
}

/* Live Paystack account view for admin reporting. The ledger endpoint is
   intentionally limited to the latest page: the database aggregates below
   remain the all-time Tictify audit totals, while these entries reconcile the
   account's actual recent pay-ins and pay-outs. */
export async function getPaystackAccountSnapshot({ perPage = 20 } = {}) {
  const empty = {
    configured: paystackConfigured,
    currency: "NGN",
    balance: null,
    balanceFetchedAt: null,
    ledger: [],
    ledgerMeta: null,
    ledgerFetchedAt: null,
    recentMoneyIn: 0,
    recentMoneyOut: 0,
    recentNetChange: 0,
    error: null,
  };

  if (!paystackConfigured) {
    return { ...empty, error: "Paystack is not configured" };
  }

  const [balanceResult, ledgerResult] = await Promise.allSettled([
    paystackGet("/balance"),
    paystackGet("/balance/ledger", { perPage, page: 1 }),
  ]);

  const snapshot = { ...empty };
  const errors = [];

  if (balanceResult.status === "fulfilled") {
    const ngn = (balanceResult.value.data || []).find(
      (item) => item.currency === "NGN",
    );
    if (ngn) {
      snapshot.balance = Number(ngn.balance || 0) / 100;
      snapshot.balanceFetchedAt = new Date().toISOString();
    } else {
      errors.push("Paystack returned no NGN balance");
    }
  } else {
    errors.push(balanceResult.reason?.message || "Balance unavailable");
  }

  if (ledgerResult.status === "fulfilled") {
    const sourceEntries = (ledgerResult.value.data || []).filter(
      (entry) => !entry.currency || entry.currency === "NGN",
    );
    const ledger = sourceEntries.map((entry) => ({
      id: entry.id,
      difference: Number(entry.difference || 0) / 100,
      balance: Number(entry.balance || 0) / 100,
      currency: entry.currency || "NGN",
      reason: entry.reason || "",
      source: entry.model_responsible || "Paystack",
      sourceId: entry.model_row || null,
      createdAt: entry.createdAt || entry.created_at || null,
    }));

    snapshot.ledger = ledger;
    snapshot.ledgerMeta = ledgerResult.value.meta || null;
    snapshot.ledgerFetchedAt = new Date().toISOString();
    snapshot.recentMoneyIn = ledger.reduce(
      (total, entry) => total + (entry.difference > 0 ? entry.difference : 0),
      0,
    );
    snapshot.recentMoneyOut = ledger.reduce(
      (total, entry) => total + (entry.difference < 0 ? Math.abs(entry.difference) : 0),
      0,
    );
    snapshot.recentNetChange = ledger.reduce(
      (total, entry) => total + entry.difference,
      0,
    );
  } else {
    errors.push(ledgerResult.reason?.message || "Ledger unavailable");
  }

  snapshot.error = errors.length ? errors.join("; ") : null;
  return snapshot;
}

async function verifyTransfer(reference, headers) {
  if (!reference) return null;
  try {
    const res = await fetch(
      `https://api.paystack.co/transfer/verify/${encodeURIComponent(reference)}`,
      { headers },
    );
    const body = await res.json();
    if (body.status && body.data?.reference === reference) return body.data;
  } catch {
    // The original transfer error is more useful to the retry queue.
  }
  return null;
}

/* Create (or reuse) a transfer recipient, then fire the transfer.
   Returns { reference, transferCode, status } or throws with a
   human-readable message. */
export async function payoutToBank({ amount, bankDetails, reason, reference, recipientCode }) {
  if (!paystackConfigured) {
    throw new Error("Paystack is not configured");
  }

  const headers = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  };

  /* 1. Recipient */
  let recipient = recipientCode ? { data: { recipient_code: recipientCode } } : null;
  if (!recipient) {
    const recipientRes = await fetch("https://api.paystack.co/transferrecipient", {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "nuban",
        name: bankDetails.accountName,
        account_number: bankDetails.accountNumber,
        bank_code: bankDetails.bankCode,
        currency: "NGN",
      }),
    });
    recipient = await recipientRes.json();
    if (!recipient.status) {
      throw new Error(recipient.message || "Bank account could not be verified");
    }
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
      ...(reference ? { reference } : {}),
    }),
  });
  const transfer = await transferRes.json();
  if (!transfer.status) {
    // Common causes: transfers not enabled, insufficient Paystack balance,
    // OTP required on transfers (must be disabled for automation)
    // If the request timed out after Paystack accepted it, recover the
    // existing transfer by reference instead of creating another payout.
    const existing = await verifyTransfer(reference, headers);
    if (existing && ["pending", "success"].includes(existing.status)) {
      return {
        reference: existing.reference,
        transferCode: existing.transfer_code,
        status: existing.status,
        recipientCode: recipient.data.recipient_code,
      };
    }
    throw new Error(transfer.message || "Transfer failed");
  }

  if (transfer.data?.status === "otp") {
    throw new Error("Paystack transfer OTP is enabled; disable transfer confirmation in Paystack before going live");
  }

  return {
    reference: transfer.data.reference,
    transferCode: transfer.data.transfer_code,
    status: transfer.data.status, // "pending" | "success" | "otp" ...
    recipientCode: recipient.data.recipient_code,
  };
}
