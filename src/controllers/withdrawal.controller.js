import Withdrawal from "../models/Withdrawal.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

export const requestWithdrawal = async (req, res) => {
  const { amount, bankDetails } = req.body;

  try {
    const wallet = await Wallet.findOne({ organizer: req.user._id });

    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({ message: "Insufficient wallet balance" });
    }

    // 1. DEDUCT WALLET IMMEDIATELY (Anti-Fraud Lock)
    // This prevents a user from double-clicking and firing two Paystack requests
    // before the database has time to update.
    wallet.balance -= amount;
    await wallet.save();

    try {
      // 2. CREATE PAYSTACK RECIPIENT
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
        throw new Error(`Paystack Recipient Error: ${recipientData.message}`);
      }

      const recipientCode = recipientData.data.recipient_code;

      // 3. INITIATE PAYSTACK TRANSFER
      // Paystack expects amount in Kobo (Multiply by 100)
      const amountInKobo = amount * 100;

      const transferResponse = await fetch("https://api.paystack.co/transfer", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "balance", // Pulls from your Paystack Balance
          amount: amountInKobo,
          recipient: recipientCode,
          reason: "Organizer Payout",
        }),
      });

      const transferData = await transferResponse.json();

      if (!transferData.status) {
        throw new Error(`Paystack Transfer Error: ${transferData.message}`);
      }

      // 4. LOG TRANSACTIONS UPON SUCCESS
      wallet.totalWithdrawn += amount;
      await wallet.save();

      await WalletTransaction.create({
        organizer: req.user._id,
        type: "DEBIT",
        amount,
        reference: transferData.data.reference || `WD-${Date.now()}`,
        description: "Instant Withdrawal via Paystack",
      });

      const withdrawal = await Withdrawal.create({
        organizer: req.user._id,
        amount,
        bankDetails,
        status: "APPROVED", // Instantly approved
        paystackReference: transferData.data.reference,
      });

      return res.status(200).json({
        message: "Withdrawal successful. Funds are on the way!",
        withdrawal,
      });
    } catch (paystackError) {
      // 5. ROLLBACK IF PAYSTACK FAILS
      // If the API call fails, give the user their money back immediately
      wallet.balance += amount;
      await wallet.save();

      console.error("PAYSTACK ERROR:", paystackError.message);
      return res
        .status(400)
        .json({
          message:
            paystackError.message || "Transfer failed. Balance refunded.",
        });
    }
  } catch (err) {
    console.error("WITHDRAWAL ERROR:", err);
    res
      .status(500)
      .json({ message: "Internal server error during withdrawal" });
  }
};

// You can keep this to fetch history for the user/admin
export const getAllWithdrawals = async (req, res) => {
  const withdrawals = await Withdrawal.find()
    .populate("organizer", "name email")
    .sort("-createdAt");

  res.json(withdrawals);
};
