import Wallet from "../models/Wallet.js";

/* ── GET /organizer/wallet ── */
export const getWallet = async (req, res) => {
  try {
    const wallet = await Wallet.findOneAndUpdate(
      { organizer: req.user.id },
      { $setOnInsert: { organizer: req.user.id } },
      { upsert: true, new: true },
    );
    res.json(wallet);
  } catch (err) {
    console.error("GET WALLET ERROR:", err);
    res.status(500).json({ message: "Could not fetch wallet" });
  }
};

/* ── POST /organizer/withdraw ── */
export const withdraw = async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Invalid withdrawal amount" });
    }

    const wallet = await Wallet.findOne({ organizer: req.user.id });
    if (!wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    if (wallet.balance < amount) {
      return res.status(400).json({ message: "Insufficient balance" });
    }

    wallet.balance -= amount;
    wallet.totalWithdrawn += amount;
    await wallet.save();

    res.json({
      message: "Withdrawal successful",
      newBalance: wallet.balance,
      totalWithdrawn: wallet.totalWithdrawn,
    });
  } catch (err) {
    console.error("WITHDRAW ERROR:", err);
    res.status(500).json({ message: "Withdrawal failed" });
  }
};
