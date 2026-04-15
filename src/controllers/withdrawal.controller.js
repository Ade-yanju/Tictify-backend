import Withdrawal from "../models/Withdrawal.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

/* ================= REQUEST WITHDRAWAL ================= */
export const requestWithdrawal = async (req, res) => {
  const { amount, bankDetails } = req.body;
  const userId = req.user.id;

  try {
    const wallet = await Wallet.findOne({ organizer: userId });

    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({ message: "Insufficient wallet balance" });
    }

    // 1. Immediate Deduction (Anti-fraud lock)
    wallet.balance -= amount;
    await wallet.save();

    try {
      // 2. Create Paystack Recipient
      const recipientResponse = await fetch(
        "https://api.paystack.co/transferrecipient",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "nuban",
            name: bankDetails.accountName,
            account_number: bankDetails.accountNumber,
            bank_code: bankDetails.bankCode,
            currency: "NGN",
          }),
        },
      );

      const recipientData = await recipientResponse.json();

      if (!recipientData.status) {
        throw new Error(`Recipient Setup Failed: ${recipientData.message}`);
      }

      // 3. Initiate Transfer
      const transferResponse = await fetch("https://api.paystack.co/transfer", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "balance",
          amount: amount * 100, // Convert to Kobo
          recipient: recipientData.data.recipient_code,
          reason: `Payout for ${bankDetails.accountName}`,
        }),
      });

      const transferData = await transferResponse.json();

      if (!transferData.status) {
        throw new Error(`Transfer Failed: ${transferData.message}`);
      }

      // 4. Log Success
      wallet.totalWithdrawn = (wallet.totalWithdrawn || 0) + amount;
      await wallet.save();

      await WalletTransaction.create({
        organizer: userId,
        type: "DEBIT",
        amount,
        reference: transferData.data.reference,
        description: "Instant Payout via Paystack",
      });

      const withdrawal = await Withdrawal.create({
        organizer: userId,
        amount,
        bankDetails,
        status: "APPROVED",
        paystackReference: transferData.data.reference,
      });

      return res.status(200).json({
        message: "Funds are on the way!",
        withdrawal,
      });
    } catch (paystackError) {
      // ROLLBACK: Return money to wallet if Paystack rejects the request
      wallet.balance += amount;
      await wallet.save();

      console.error("PAYSTACK REJECTION:", paystackError.message);
      return res.status(400).json({ message: paystackError.message });
    }
  } catch (err) {
    console.error("INTERNAL WITHDRAWAL ERROR:", err);
    res
      .status(500)
      .json({ message: "Critical error during withdrawal processing." });
  }
};

/* ================= GET ALL WITHDRAWALS (The Missing Export) ================= */
export const getAllWithdrawals = async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch withdrawals specifically for this organizer
    const withdrawals = await Withdrawal.find({ organizer: userId }).sort({
      createdAt: -1,
    });

    res.json(withdrawals);
  } catch (error) {
    console.error("FETCH WITHDRAWALS ERROR:", error);
    res.status(500).json({ message: "Could not load withdrawal history." });
  }
};
