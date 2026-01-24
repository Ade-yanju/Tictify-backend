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
      return res.status(400).json({ message: "Event not available" });
    }

    const ticket = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticket) {
      return res.status(400).json({ message: "Invalid ticket type" });
    }

    const amount = Number(ticket.price);

    // 🔐 REAL reference
    const reference = `TICTIFY_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

    // 🧾 CREATE PAYMENT RECORD (PENDING)
    await Payment.create({
      event: eventId,
      organizer: event.organizer,
      ticketType,
      email,
      amount,
      reference,
      status: "PENDING",
    });

    // 🟢 INIT ERCASPAY
    const paymentUrl = await initiateErcaspay({
      amount,
      email,
      reference,
      metadata: {
        eventId,
        ticketType,
        email,
      },
    });

    return res.json({ paymentUrl });
  } catch (error) {
    console.error("PAYMENT INIT ERROR:", error);
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
