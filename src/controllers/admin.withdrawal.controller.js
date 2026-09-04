import Withdrawal from "../models/Withdrawal.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";
import {
  payoutToBank,
  paystackConfigured,
} from "../services/paystack.service.js";

/* ================= GET ALL WITHDRAWALS ================= */
export const getAllWithdrawals = async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find()
      .populate("organizer", "name email")
      .sort("-createdAt");

    res.json(withdrawals);
  } catch (err) {
    console.error("ADMIN WITHDRAWALS ERROR:", err);
    res.status(500).json({ message: "Failed to load withdrawals" });
  }
};

/* =====================================================
   APPROVE WITHDRAWAL
   Funds were already HELD at request time — approving
   never touches the balance again (no double-deduction).
   If Paystack is configured, the transfer fires here;
   otherwise the request is approved for manual payout.
===================================================== */
export const approveWithdrawal = async (req, res) => {
  try {
    /* Atomic claim: only ONE admin can move PENDING → processing */
    const withdrawal = await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: "PENDING" },
      {
        status: "APPROVED",
        processedBy: req.user._id,
        approvedAt: new Date(),
      },
      { new: true },
    );

    if (!withdrawal) {
      const exists = await Withdrawal.findById(req.params.id);
      return exists
        ? res.status(400).json({ message: "Already processed" })
        : res.status(404).json({ message: "Withdrawal not found" });
    }

    let paystackReference = null;

    /* ── Automatic payout when Paystack is configured ── */
    if (paystackConfigured) {
      try {
        // netAmount = amount minus the organizer-borne transfer fee
        // (legacy records without netAmount fall back to full amount)
        const payAmount = withdrawal.netAmount ?? withdrawal.amount;
        const payout = await payoutToBank({
          amount: payAmount,
          bankDetails: withdrawal.bankDetails || {},
          reason: `Tictify payout — ${withdrawal.bankDetails?.accountName}`,
          reference: `wd_${withdrawal._id}`,
          recipientCode: withdrawal.paystackRecipientCode,
        });

        paystackReference = payout.reference;
        withdrawal.status = "APPROVED";
        withdrawal.paystackReference = paystackReference;
        withdrawal.paystackRecipientCode = payout.recipientCode;
        await withdrawal.save();
      } catch (paystackErr) {
        /* Transfer failed → revert claim so it can be retried/rejected */
        withdrawal.status = "PENDING";
        withdrawal.processedBy = undefined;
        withdrawal.approvedAt = undefined;
        await withdrawal.save();
        console.error("PAYSTACK PAYOUT ERROR:", paystackErr.message);
        return res.status(502).json({
          message: `Payout failed: ${paystackErr.message}. The request is back in the pending queue.`,
        });
      }
    }

    /* A Paystack transfer is accounted for by transfer.success. Keep the
       legacy manual-payout path's bookkeeping here. */
    if (!paystackConfigured) {
      await Wallet.updateOne(
        { organizer: withdrawal.organizer },
        { $inc: { totalWithdrawn: withdrawal.amount } },
      );
      await WalletTransaction.create({
        organizer: withdrawal.organizer,
        type: "DEBIT",
        amount: withdrawal.amount,
        reference: `WD-APPROVED-${withdrawal._id}`,
        description: "Withdrawal approved — manual payout",
      });
    }

    res.json({
      message: paystackConfigured
        ? "Withdrawal approved and sent to Paystack"
        : "Withdrawal approved for manual payout",
      status: withdrawal.status,
    });
  } catch (err) {
    console.error("APPROVE WITHDRAWAL ERROR:", err);
    res.status(500).json({ message: "Approval failed" });
  }
};

/* =====================================================
   REJECT WITHDRAWAL — refunds the held amount atomically
===================================================== */
export const rejectWithdrawal = async (req, res) => {
  try {
    /* Atomic claim prevents double-refund by two admins */
    const withdrawal = await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: "PENDING" },
      {
        status: "REJECTED",
        processedBy: req.user._id,
        approvedAt: new Date(),
      },
      { new: true },
    );

    if (!withdrawal) {
      const exists = await Withdrawal.findById(req.params.id);
      return exists
        ? res.status(400).json({ message: "Already processed" })
        : res.status(404).json({ message: "Withdrawal not found" });
    }

    /* ── Return the held funds to the organizer ── */
    await Wallet.updateOne(
      { organizer: withdrawal.organizer },
      { $inc: { balance: withdrawal.amount } },
      { upsert: true },
    );

    await WalletTransaction.create({
      organizer: withdrawal.organizer,
      type: "CREDIT",
      amount: withdrawal.amount,
      reference: `WD-REFUND-${withdrawal._id}`,
      description: "Withdrawal rejected — held funds returned to wallet",
    });

    res.json({ message: "Withdrawal rejected and funds returned" });
  } catch (err) {
    console.error("REJECT WITHDRAWAL ERROR:", err);
    res.status(500).json({ message: "Rejection failed" });
  }
};
