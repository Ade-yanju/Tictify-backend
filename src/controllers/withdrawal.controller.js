import Withdrawal from "../models/Withdrawal.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";
import crypto from "crypto";

const MIN_WITHDRAWAL = 500; // ₦
const MAX_WITHDRAWAL = 5_000_000; // ₦ sanity ceiling per request

/* =====================================================
   REQUEST WITHDRAWAL — escrow model
   1. Strictly validate amount + bank details
   2. Atomically HOLD the funds (balance can never go
      negative, races can never double-spend)
   3. Create a PENDING request for admin review
===================================================== */
export const requestWithdrawal = async (req, res) => {
  const userId = req.user.id;

  try {
    /* ── 1. Validate amount: must be a positive integer in range ── */
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
      return res.status(400).json({ message: "Invalid withdrawal amount" });
    }
    if (amount < MIN_WITHDRAWAL) {
      return res
        .status(400)
        .json({ message: `Minimum withdrawal is ₦${MIN_WITHDRAWAL}` });
    }
    if (amount > MAX_WITHDRAWAL) {
      return res.status(400).json({
        message: `Maximum per request is ₦${MAX_WITHDRAWAL.toLocaleString()}`,
      });
    }

    /* ── 2. Validate bank details ── */
    const bd = req.body.bankDetails || {};
    const accountNumber = String(bd.accountNumber || "").trim();
    const accountName = String(bd.accountName || "").trim();
    const bankCode = String(bd.bankCode || "").trim();
    const bankName = String(bd.bankName || "").trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      return res
        .status(400)
        .json({ message: "Account number must be exactly 10 digits" });
    }
    if (accountName.length < 3) {
      return res.status(400).json({ message: "Account name is required" });
    }
    if (!bankCode || !bankName) {
      return res.status(400).json({ message: "Please select a bank" });
    }

    /* ── 3. One pending request at a time ── */
    const pending = await Withdrawal.findOne({
      organizer: userId,
      status: "PENDING",
    });
    if (pending) {
      return res.status(409).json({
        message:
          "You already have a pending withdrawal. Wait for it to be processed.",
      });
    }

    /* ── 4. ATOMIC HOLD: verify balance and deduct in ONE database
           operation — concurrent requests cannot both pass ── */
    const wallet = await Wallet.findOneAndUpdate(
      { organizer: userId, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { new: true },
    );

    if (!wallet) {
      const current = await Wallet.findOne({ organizer: userId });
      return res.status(400).json({
        message: `Insufficient wallet balance. Available: ₦${(
          current?.balance || 0
        ).toLocaleString()}`,
      });
    }

    /* ── 5. Record the request + audit trail ── */
    const withdrawal = await Withdrawal.create({
      organizer: userId,
      amount,
      bankDetails: { bankName, bankCode, accountNumber, accountName },
      status: "PENDING",
    });

    await WalletTransaction.create({
      organizer: userId,
      type: "DEBIT",
      amount,
      reference: `WD-HOLD-${withdrawal._id}`,
      description: `Withdrawal request — funds held pending admin approval (${bankName} ····${accountNumber.slice(-4)})`,
    });

    return res.status(201).json({
      message:
        "Withdrawal request submitted. Funds are reserved and will be paid out once approved.",
      withdrawal,
      newBalance: wallet.balance,
    });
  } catch (err) {
    console.error("WITHDRAWAL REQUEST ERROR:", err);
    return res
      .status(500)
      .json({ message: "Could not process withdrawal request" });
  }
};

/* ================= ORGANIZER: WITHDRAWAL HISTORY ================= */
export const getAllWithdrawals = async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ organizer: req.user.id }).sort({
      createdAt: -1,
    });
    res.json(withdrawals);
  } catch (error) {
    console.error("FETCH WITHDRAWALS ERROR:", error);
    res.status(500).json({ message: "Could not load withdrawal history." });
  }
};
