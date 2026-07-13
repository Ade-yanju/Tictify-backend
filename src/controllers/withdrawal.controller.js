import Withdrawal from "../models/Withdrawal.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";
import crypto from "crypto";
import {
  payoutToBank,
  paystackConfigured,
  transferFee,
} from "../services/paystack.service.js";
import { sendEmail } from "../services/email.service.js";
import User from "../models/User.js";

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

    /* ── 4. Balance sanity check (funds are HELD only after the
           emailed confirmation code is entered — see confirmWithdrawal) ── */
    const wallet = await Wallet.findOne({ organizer: userId });
    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({
        message: `Insufficient wallet balance. Available: ₦${(
          wallet?.balance || 0
        ).toLocaleString()}`,
      });
    }

    /* ── 5. Anti-fraud confirmation: 6-digit code to the ACCOUNT email ── */
    const fee = transferFee(amount);
    const netAmount = amount - fee;

    // invalidate any earlier unconfirmed request
    await Withdrawal.updateMany(
      { organizer: userId, status: "AWAITING_OTP" },
      { status: "EXPIRED" },
    );

    const otp = String(crypto.randomInt(100000, 1000000));
    const withdrawal = await Withdrawal.create({
      organizer: userId,
      amount,
      transferFee: fee,
      netAmount,
      bankDetails: { bankName, bankCode, accountNumber, accountName },
      status: "AWAITING_OTP",
      otpHash: crypto.createHash("sha256").update(otp).digest("hex"),
      otpExpires: new Date(Date.now() + 10 * 60 * 1000),
      otpAttempts: 0,
    });

    const account = await User.findById(userId).select("email name");

    // has this bank account been used before? (new destinations get a louder warning)
    const usedBefore = await Withdrawal.findOne({
      organizer: userId,
      _id: { $ne: withdrawal._id },
      status: { $in: ["PENDING", "APPROVED", "PAID"] },
      "bankDetails.accountNumber": accountNumber,
    });

    sendEmail({
      to: account.email,
      subject: `Confirm your withdrawal — code ${otp}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#f9fafb;border-radius:16px;">
          <h2 style="color:#1a1a1a;margin-top:0;">Confirm your withdrawal</h2>
          <p style="color:#555;line-height:1.7;">You (or someone using your account) requested a payout:</p>
          <div style="background:#fff;padding:18px 22px;border-radius:12px;border-left:4px solid #E8C96A;margin:16px 0;">
            <p style="margin:4px 0;"><strong>You receive:</strong> ₦${netAmount.toLocaleString()} <span style="color:#888;">(₦50 stamp duty + ₦50 platform fee)</span></p>
            <p style="margin:4px 0;"><strong>To:</strong> ${bankName} ····${accountNumber.slice(-4)} (${accountName})</p>
          </div>
          ${usedBefore ? "" : `<p style="color:#B00020;font-weight:bold;">⚠️ This bank account has never been used on your Tictify account before.</p>`}
          <div style="text-align:center;background:#fff;padding:18px;border-radius:12px;margin:16px 0;">
            <p style="margin:0 0 6px;color:#888;font-size:12px;">YOUR CONFIRMATION CODE (expires in 10 minutes)</p>
            <p style="margin:0;font-size:32px;font-weight:800;letter-spacing:8px;color:#1a1a1a;">${otp}</p>
          </div>
          <p style="color:#B00020;font-size:13px;line-height:1.7;"><strong>Didn't request this?</strong> Do NOT share this code. Change your password immediately (Forgot password on the login page) and contact tictify@gmail.com — no money leaves your wallet without this code.</p>
        </div>
      `,
    }).catch((e) => console.error("Withdrawal OTP email failed:", e.message));

    const masked = account.email.replace(/^(..).*(@.*)$/, "$1•••$2");
    return res.status(201).json({
      requiresOtp: true,
      withdrawalId: withdrawal._id,
      message: `We sent a 6-digit confirmation code to ${masked}. Enter it to release the payout.`,
      netAmount,
      transferFee: fee,
    });
  } catch (err) {
    console.error("WITHDRAWAL REQUEST ERROR:", err);
    return res
      .status(500)
      .json({ message: "Could not process withdrawal request" });
  }
};

/* =====================================================
   CONFIRM WITHDRAWAL — verifies the emailed code, THEN
   holds the funds and (in instant mode) fires the payout
===================================================== */
export const confirmWithdrawal = async (req, res) => {
  try {
    const userId = req.user.id;
    const { withdrawalId } = req.params;
    const otp = String(req.body.otp || "").trim();

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: "Enter the 6-digit code from your email" });
    }

    const withdrawal = await Withdrawal.findOne({
      _id: withdrawalId,
      organizer: userId,
      status: "AWAITING_OTP",
    });
    if (!withdrawal) {
      return res.status(404).json({ message: "No withdrawal awaiting confirmation" });
    }

    if (withdrawal.otpExpires < new Date()) {
      withdrawal.status = "EXPIRED";
      await withdrawal.save();
      return res.status(400).json({ message: "Code expired — request the withdrawal again" });
    }

    if (withdrawal.otpAttempts >= 5) {
      withdrawal.status = "EXPIRED";
      await withdrawal.save();
      return res.status(400).json({ message: "Too many wrong attempts — request the withdrawal again" });
    }

    const hash = crypto.createHash("sha256").update(otp).digest("hex");
    if (hash !== withdrawal.otpHash) {
      withdrawal.otpAttempts += 1;
      await withdrawal.save();
      return res.status(400).json({
        message: `Wrong code — ${5 - withdrawal.otpAttempts} attempt${5 - withdrawal.otpAttempts === 1 ? "" : "s"} left`,
      });
    }

    /* ── Code verified: ATOMIC HOLD (races can't double-spend) ── */
    const wallet = await Wallet.findOneAndUpdate(
      { organizer: userId, balance: { $gte: withdrawal.amount } },
      { $inc: { balance: -withdrawal.amount } },
      { new: true },
    );
    if (!wallet) {
      withdrawal.status = "EXPIRED";
      await withdrawal.save();
      return res.status(400).json({ message: "Insufficient balance — the request was cancelled" });
    }

    withdrawal.status = "PENDING";
    withdrawal.otpHash = undefined;
    withdrawal.otpExpires = undefined;
    await withdrawal.save();

    const bd = withdrawal.bankDetails;
    await WalletTransaction.create({
      organizer: userId,
      type: "DEBIT",
      amount: withdrawal.amount,
      reference: `WD-HOLD-${withdrawal._id}`,
      description: `Withdrawal — ₦${withdrawal.netAmount.toLocaleString()} to ${bd.bankName} ····${bd.accountNumber.slice(-4)} (₦${withdrawal.transferFee} bank transfer fee)`,
    });

    /* ── INSTANT PAYOUT (AUTO_APPROVE_WITHDRAWALS=true) ── */
    if (process.env.AUTO_APPROVE_WITHDRAWALS === "true" && paystackConfigured) {
      try {
        const payout = await payoutToBank({
          amount: withdrawal.netAmount,
          bankDetails: bd,
          reason: `Tictify payout — ${bd.accountName}`,
        });

        withdrawal.status = "PAID";
        withdrawal.paystackReference = payout.reference;
        withdrawal.approvedAt = new Date();
        await withdrawal.save();

        await Wallet.updateOne(
          { organizer: userId },
          { $inc: { totalWithdrawn: withdrawal.amount } },
        );
        await WalletTransaction.create({
          organizer: userId,
          type: "DEBIT",
          amount: withdrawal.amount,
          reference: payout.reference,
          description: "Instant payout via Paystack",
        });

        return res.json({
          message: `Confirmed! ₦${withdrawal.netAmount.toLocaleString()} is on the way to your bank.`,
          status: "PAID",
        });
      } catch (paystackErr) {
        /* Payout couldn't start (usually the T+1 settlement gap) —
           funds stay held and the payout queue retries automatically
           every few minutes until the balance covers it. */
        console.error("AUTO PAYOUT FAILED:", paystackErr.message);
        withdrawal.failureReason = paystackErr.message;
        await withdrawal.save();
      }

      return res.json({
        message: `Confirmed! ₦${withdrawal.netAmount.toLocaleString()} will be sent to your bank automatically — usually within 24 hours. Nothing else for you to do.`,
        status: "PENDING",
      });
    }

    return res.json({
      message: `Confirmed! You'll receive ₦${withdrawal.netAmount.toLocaleString()} once processed.`,
      status: "PENDING",
    });
  } catch (err) {
    console.error("CONFIRM WITHDRAWAL ERROR:", err);
    return res.status(500).json({ message: "Confirmation failed" });
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
