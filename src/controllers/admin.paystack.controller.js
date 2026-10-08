import Withdrawal from "../models/Withdrawal.js";
import {
  getPaystackAccountActivity,
  getAvailableBalance,
  getPaystackTransfer,
} from "../services/paystack.service.js";

function positiveInt(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function withdrawalReferenceSet(withdrawal) {
  return [
    withdrawal.paystackReference,
    withdrawal.paystackTransferCode,
    `wd_${withdrawal._id}`,
    String(withdrawal._id),
  ]
    .filter(Boolean)
    .map(String);
}

function withdrawalSummary(withdrawal) {
  if (!withdrawal) return null;
  return {
    id: withdrawal._id,
    status: withdrawal.status === "APPROVED" ? "PROCESSING" : withdrawal.status === "PAID" ? "SUCCESS" : withdrawal.status,
    requestedAmount: Number(withdrawal.amount || 0),
    amountToBank: Number(withdrawal.netAmount ?? withdrawal.amount ?? 0),
    transferFee: Number(withdrawal.transferFee || 0),
    createdAt: withdrawal.createdAt,
    paystackReference: withdrawal.paystackReference || "",
    paystackTransferCode: withdrawal.paystackTransferCode || "",
    bankName: withdrawal.bankDetails?.bankName || "",
    accountLast4: String(withdrawal.bankDetails?.accountNumber || "").slice(-4),
    organizer: withdrawal.organizer
      ? {
          id: withdrawal.organizer._id,
          name: withdrawal.organizer.name || "Organizer",
          email: withdrawal.organizer.email || "",
        }
      : null,
  };
}

function attribution(entry, transfer, withdrawals) {
  const providerReferences = [
    entry.sourceId,
    transfer?.id,
    transfer?.reference,
    transfer?.transfer_code,
  ].filter(Boolean).map(String);

  const matched = withdrawals.find((withdrawal) => {
    const references = withdrawalReferenceSet(withdrawal);
    return providerReferences.some((reference) => references.includes(reference));
  });

  if (matched) {
    return {
      origin: "ORGANIZER_WITHDRAWAL",
      originLabel: "Organizer withdrawal",
      initiatedFrom: "Organizer account",
      withdrawal: withdrawalSummary(matched),
    };
  }

  if (String(entry.source).toLowerCase() === "transfer") {
    return {
      origin: "UNLINKED_TRANSFER",
      originLabel: "Transfer not linked to a Tictify withdrawal",
      initiatedFrom: "Paystack or another integration",
      withdrawal: null,
    };
  }

  return {
    origin: "PAYSTACK_ACTIVITY",
    originLabel: "Paystack account activity",
    initiatedFrom: "Not an organizer withdrawal",
    withdrawal: null,
  };
}

export const adminPaystackActivity = async (req, res) => {
  const page = positiveInt(req.query.page, 1, 10_000);
  const perPage = positiveInt(req.query.perPage, 25, 50);

  try {
    const [activity, availableBalance] = await Promise.all([
      getPaystackAccountActivity({ page, perPage }),
      getAvailableBalance(),
    ]);
    if (activity.error && !activity.entries.length) {
      return res.status(activity.configured ? 502 : 503).json({
        message: activity.error,
        configured: activity.configured,
      });
    }

    const withdrawals = await Withdrawal.find({
      $or: [
        { paystackReference: { $exists: true, $ne: "" } },
        { paystackTransferCode: { $exists: true, $ne: "" } },
      ],
    })
      .select("organizer amount netAmount transferFee status createdAt bankDetails paystackReference paystackTransferCode")
      .populate("organizer", "name email")
      .lean();

    const transferEntries = activity.entries.filter(
      (entry) => String(entry.source).toLowerCase() === "transfer" && entry.sourceId,
    );
    const transferDetails = await Promise.all(
      transferEntries.map(async (entry) => [String(entry.sourceId), await getPaystackTransfer(entry.sourceId)]),
    );
    const transfersByLedgerId = new Map(transferDetails);

    const entries = activity.entries.map((entry) => {
      const transfer = transfersByLedgerId.get(String(entry.sourceId)) || null;
      return {
        ...entry,
        providerReference: transfer?.reference || "",
        providerTransferCode: transfer?.transfer_code || "",
        providerStatus: transfer?.status || "",
        ...attribution(entry, transfer, withdrawals),
      };
    });

    return res.json({
      configured: activity.configured,
      availableBalance,
      entries,
      meta: activity.meta,
      fetchedAt: activity.fetchedAt,
      warning: activity.error || null,
    });
  } catch (error) {
    console.error("ADMIN PAYSTACK ACTIVITY ERROR:", error);
    return res.status(500).json({ message: "Unable to load Paystack account activity" });
  }
};
