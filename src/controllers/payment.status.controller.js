import Payment from "../models/Payment.js";

/* =====================================================
   PAYMENT STATUS (PUBLIC, POLLED)
   Bank-transfer guests sit on the checkout page waiting
   for the money to land, so this is polled every ~5s.

   Deliberately returns ONLY the status + reference — the
   reference is effectively a bearer token, so no buyer
   data (email, phone, amount) may leak through here.
===================================================== */
export const getPaymentStatus = async (req, res) => {
  try {
    const { reference } = req.params;

    const payment = await Payment.findOne({ reference }).select("status reference");
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    return res.json({ status: payment.status, reference: payment.reference });
  } catch (err) {
    console.error("PAYMENT STATUS ERROR:", err);
    return res.status(500).json({ message: "Unable to load payment status" });
  }
};
