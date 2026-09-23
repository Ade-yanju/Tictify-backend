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

