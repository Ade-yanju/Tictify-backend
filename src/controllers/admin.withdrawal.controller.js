import Withdrawal from "../models/Withdrawal.js";


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
