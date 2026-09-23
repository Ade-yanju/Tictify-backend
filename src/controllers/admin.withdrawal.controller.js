import Withdrawal from "../models/Withdrawal.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";


/* ================= GET ALL WITHDRAWALS ================= */
export const getAllWithdrawals = async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find()
      .populate("organizer", "name email")
      .populate("processedBy", "name email")
      .sort("-createdAt");

    res.json(withdrawals.map((withdrawal) => { const item = withdrawal.toObject(); item.status = item.status === "APPROVED" ? "PROCESSING" : item.status === "PAID" ? "SUCCESS" : item.status; return item; }));
  } catch (err) {
    console.error("ADMIN WITHDRAWALS ERROR:", err);
    res.status(500).json({ message: "Failed to load withdrawals" });
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
