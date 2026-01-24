import Withdrawal from "../models/Withdrawal.js";
import Wallet from "../models/Wallet.js";

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

/* ================= APPROVE WITHDRAWAL ================= */
export const approveWithdrawal = async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findById(req.params.id);

    if (!withdrawal)
      return res.status(404).json({ message: "Withdrawal not found" });

    if (withdrawal.status !== "PENDING") {
      return res.status(400).json({ message: "Already processed" });
    }

    const wallet = await Wallet.findOne({ organizer: withdrawal.organizer });

    if (!wallet || wallet.balance < withdrawal.amount) {
      return res
        .status(400)
        .json({ message: "Insufficient organizer balance" });
    }

    wallet.balance -= withdrawal.amount;
    await wallet.save();

    withdrawal.status = "APPROVED";
    withdrawal.processedBy = req.user._id;
    withdrawal.approvedAt = new Date();

    await withdrawal.save();

    res.json({ message: "Withdrawal approved" });
  } catch (err) {
    console.error("APPROVE WITHDRAWAL ERROR:", err);
    res.status(500).json({ message: "Approval failed" });
  }
};

/* ================= REJECT WITHDRAWAL ================= */
export const rejectWithdrawal = async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findById(req.params.id);

    if (!withdrawal)
      return res.status(404).json({ message: "Withdrawal not found" });

    if (withdrawal.status !== "PENDING") {
      return res.status(400).json({ message: "Already processed" });
    }

    withdrawal.status = "REJECTED";
    withdrawal.processedBy = req.user._id;
    withdrawal.approvedAt = new Date();

    await withdrawal.save();

    res.json({ message: "Withdrawal rejected" });
  } catch (err) {
    console.error("REJECT WITHDRAWAL ERROR:", err);
    res.status(500).json({ message: "Rejection failed" });
  }
};
