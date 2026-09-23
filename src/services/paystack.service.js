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

function paystackError(message, category = "TRANSIENT") {
  const error = new Error(message || "Paystack request failed");
  error.category = category;
  return error;
}

function classifyTransferError(message = "") {
  const text = String(message).toLowerCase();
  if (/duplicate|already exists|unique reference|reference already/.test(text)) {
    return "RECONCILIATION_REQUIRED";
  }
  if (/insufficient|balance|funds|settlement/.test(text)) {
    return "PAYSTACK_BALANCE_LOW";
  }
  if (/otp|one[- ]time password|transfer confirmation/.test(text)) {
    return "TRANSFER_OTP_REQUIRED";
  }
  if (/recipient|account|bank|nuban/.test(text)) {
    return "INVALID_RECIPIENT";
  }
  return "TRANSIENT";
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

/* Bank codes and account-name resolution are also provider-owned data. Keep
   both behind the backend so the browser never becomes the authority for a
   bank code or for whether an account can receive money. */
export async function getPaystackBanks() {
  if (!paystackConfigured) return [];
  const body = await paystackGet("/bank", {
    country: "nigeria",
    currency: "NGN",
    perPage: 100,
  });
  return (body.data || [])
    .filter((bank) => bank?.active !== false && bank?.code && bank?.name)
    .map((bank) => ({
      code: String(bank.code),
      name: String(bank.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolvePaystackAccount({ accountNumber, bankCode }) {
  if (!paystackConfigured) return null;
  const body = await paystackGet("/bank/resolve", {
    account_number: accountNumber,
    bank_code: bankCode,
  });
  return body.data || null;
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

/*
 * Reconcile an ambiguous transfer before retrying it.
 *
 * Paystack documents GET /transfer/:id_or_code, not the old
 * /transfer/verify/:reference path. A transfer reference is not guaranteed
 * to work as the path identifier, so the list fallback also searches by
 * reference. This is what prevents a timeout/duplicate-reference response
 * from creating a second payout attempt.
 */
async function findTransferByReference(reference) {
  if (!reference) return null;

  try {
    const direct = await paystackGet(
      `/transfer/${encodeURIComponent(reference)}`,
    );
    if (direct.data?.reference === reference) return direct.data;
  } catch {
    // Fall through to the documented transfer list search.
  }

  try {
    // The transfer was just initiated, so it should be near the first page.
    // A bounded search keeps a broken Paystack response from blocking payout.
    for (let page = 1; page <= 3; page += 1) {
      const body = await paystackGet("/transfer", {
        perPage: 100,
        page,
      });
      const match = (body.data || []).find(
        (transfer) => transfer.reference === reference,
      );
      if (match) return match;
      if ((body.data || []).length < 100) break;
    }
  } catch {
    // The caller will retry the same idempotent reference later.
  }

  return null;
}

function nextTransferReference(reference) {
  const suffix = Date.now().toString(36);
  return `${String(reference || "wd")}_${suffix}`.slice(0, 50);
}

/* Create (or reuse) a transfer recipient, then fire the transfer.
   Returns { reference, transferCode, status } or throws with a
   human-readable message. */
export async function payoutToBank({ amount, bankDetails, reason, reference, recipientCode }) {
  if (!paystackConfigured) {
    throw paystackError("Paystack is not configured", "PAYSTACK_NOT_CONFIGURED");
  }

  const headers = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  };

  /* 1. Recipient */
  let recipient = recipientCode ? { data: { recipient_code: recipientCode } } : null;
  if (!recipient) {
    const recipientController = new AbortController();
    const recipientTimeout = setTimeout(() => recipientController.abort(), 8_000);
    let recipientRes;
    try {
      recipientRes = await fetch("https://api.paystack.co/transferrecipient", {
        method: "POST",
        headers,
        signal: recipientController.signal,
        body: JSON.stringify({
          type: "nuban",
          name: bankDetails.accountName,
          account_number: bankDetails.accountNumber,
          bank_code: bankDetails.bankCode,
          currency: "NGN",
        }),
      });
    } finally {
      clearTimeout(recipientTimeout);
    }
    recipient = await recipientRes.json();
    if (!recipient.status) {
      throw paystackError(
        recipient.message || "Bank account could not be verified",
        "INVALID_RECIPIENT",
      );
    }
  }

  /* 2. Transfer (amount in kobo) */
  const transferController = new AbortController();
  const transferTimeout = setTimeout(() => transferController.abort(), 8_000);
  let transferRes;
  try {
    transferRes = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers,
      signal: transferController.signal,
      body: JSON.stringify({
        source: "balance",
        amount: Math.round(amount * 100),
        recipient: recipient.data.recipient_code,
        reason: reason || "Tictify payout",
        ...(reference ? { reference } : {}),
      }),
    });
  } catch (error) {
    /* A timeout is ambiguous: Paystack may have accepted the transfer. */
    const existing = await findTransferByReference(reference);
    if (existing && ["pending", "success"].includes(existing.status)) {
      return {
        reference: existing.reference,
        transferCode: existing.transfer_code,
        status: existing.status,
        recipientCode: recipient.data.recipient_code,
      };
    }
    if (existing && ["failed", "reversed"].includes(existing.status)) {
      // A confirmed failed/reversed transfer cannot be retried with its old
      // unique reference. It moved no money, so a new idempotency key is safe.
      return payoutToBank({
        amount,
        bankDetails,
        reason,
        reference: nextTransferReference(reference),
        recipientCode: recipient.data.recipient_code,
      });
    }
    throw paystackError(
      error?.name === "AbortError"
        ? "Paystack transfer response timed out"
        : error?.message,
      "RECONCILIATION_REQUIRED",
    );
  } finally {
    clearTimeout(transferTimeout);
  }
  const transfer = await transferRes.json();
  if (!transfer.status) {
    // If the request was accepted but the response was lost, recover the
    // existing transfer by its unique reference before any retry.
    const existing = await findTransferByReference(reference);
    if (existing && ["pending", "success"].includes(existing.status)) {
      return {
        reference: existing.reference,
        transferCode: existing.transfer_code,
        status: existing.status,
        recipientCode: recipient.data.recipient_code,
      };
    }
    if (existing && ["failed", "reversed"].includes(existing.status)) {
      // The old reference is permanently consumed after a confirmed failure.
      return payoutToBank({
        amount,
        bankDetails,
        reason,
        reference: nextTransferReference(reference),
        recipientCode: recipient.data.recipient_code,
      });
    }
    throw paystackError(
      transfer.message || "Transfer failed",
      classifyTransferError(transfer.message),
    );
  }

  if (transfer.data?.status === "otp") {
    throw paystackError(
      "Paystack transfer OTP is enabled; disable transfer confirmation in Paystack before going live",
      "TRANSFER_OTP_REQUIRED",
    );
  }

  return {
    reference: transfer.data.reference,
    transferCode: transfer.data.transfer_code,
    status: transfer.data.status, // "pending" | "success" | "otp" ...
    recipientCode: recipient.data.recipient_code,
  };
}
