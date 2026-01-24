import crypto from "crypto";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";

export const initiatePayment = async (req, res) => {
  try {
    const { eventId, ticketType, email } = req.body;

    if (!eventId || !ticketType || !email) {
      return res.status(400).json({ message: "Invalid payment request" });
    }

    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE") {
      return res.status(400).json({ message: "Invalid event" });
    }

    const ticket = event.ticketTypes.find(t => t.name === ticketType);
    if (!ticket) {
      return res.status(400).json({ message: "Invalid ticket type" });
    }

    const amount = Number(ticket.price);

    const reference = `TICTIFY-${crypto.randomBytes(8).toString("hex")}`;

    // 🔗 ERCASPAY INIT
    const ercaspayRes = await fetch("https://api.ercaspay.com/api/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.ERCASPAY_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "NGN",
        email,
        reference,
        callback_url: `${process.env.FRONTEND_URL}/payment/processing`,
        metadata: {
          eventId,
          ticketType,
          email,
        },
      }),
    });

    const ercaspayData = await ercaspayRes.json();

    if (!ercaspayData?.data?.checkout_url) {
      throw new Error("ERCASPAY init failed");
    }

    return res.json({
      paymentUrl: ercaspayData.data.checkout_url,
    });
  } catch (err) {
    console.error("PAYMENT INIT ERROR:", err);
    return res.status(500).json({ message: "Unable to initialize payment" });
  }
};

export const getPaymentStatus = async (req, res) => {
  try {
    const { reference } = req.params;

    const payment = await Payment.findOne({ reference });

    if (!payment) {
      return res.status(404).json({ status: "NOT_FOUND" });
    }

    return res.json({ status: payment.status });
  } catch {
    return res.status(500).json({ status: "ERROR" });
  }
};
