import Withdrawal from "../models/Withdrawal.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";

/* ================= ORGANIZER ================= */
export const requestWithdrawal = async (req, res) => {
  const { amount, bankDetails } = req.body;

  try {
    const wallet = await Wallet.findOne({ organizer: req.user._id });

    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({
        message: "Insufficient wallet balance",
      });
    }

    // Debit wallet immediately (ANTI-FRAUD)
    wallet.balance -= amount;
    wallet.totalWithdrawn += amount;
    await wallet.save();

    await WalletTransaction.create({
      organizer: req.user._id,
      type: "DEBIT",
      amount,
      reference: `WD-${Date.now()}`,
      description: "Withdrawal request",
    });

    const withdrawal = await Withdrawal.create({
      organizer: req.user._id,
      amount,
      bankDetails,
      status: "PENDING",
    });

    res.status(201).json({
      message: "Withdrawal request submitted successfully",
      withdrawal,
    });
  } catch (err) {
    console.error("WITHDRAWAL ERROR:", err);
    res.status(500).json({ message: "Withdrawal failed" });
  }
};

/* ================= ADMIN ================= */
export const approveWithdrawal = async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findById(req.params.id);

    if (!withdrawal) {
      return res.status(404).json({ message: "Withdrawal not found" });
    }

    if (withdrawal.status === "APPROVED") {
      return res.status(400).json({ message: "Withdrawal already approved" });
    }

    withdrawal.status = "APPROVED";
    await withdrawal.save();

    res.json({ message: "Withdrawal approved successfully" });
  } catch (err) {
    console.error("APPROVE WITHDRAWAL ERROR:", err);
    res.status(500).json({ message: "Approval failed" });
  }
};
export const getAllWithdrawals = async (req, res) => {
  const withdrawals = await Withdrawal.find()
    .populate("organizer", "name email")
    .sort("-createdAt");

  res.json(withdrawals);
};
