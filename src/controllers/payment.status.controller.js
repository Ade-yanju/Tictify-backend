import Transaction from "../models/Transaction.js";

export const getPaymentStatus = async (req, res) => {
  const { reference } = req.params;

  const tx = await Transaction.findOne({ reference });
  if (!tx) return res.status(404).json({ status: "NOT_FOUND" });

  res.json({ status: tx.status });
};
