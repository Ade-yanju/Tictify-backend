import crypto from "crypto";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";
import { generateQRCode } from "../utils/qr.js";

export const handlePaymentWebhook = async (req, res) => {
  try {
    const payload = req.body;

    if (payload.status !== "SUCCESS") {
      return res.status(200).json({ received: true });
    }

    const { reference, metadata } = payload;
    const { eventId, email, ticketType } = metadata;

    // 🔒 IDENTITY CHECK
    const payment = await Payment.findOne({ reference });
    if (!payment || payment.status === "SUCCESS") {
      return res.status(200).json({ received: true });
    }

    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE") {
      return res.status(400).json({ message: "Invalid event" });
    }

    const ticketDef = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticketDef) {
      return res.status(400).json({ message: "Invalid ticket" });
    }

    // 🟢 MARK PAYMENT SUCCESS
    payment.status = "SUCCESS";
    await payment.save();

    // 🎟️ GENERATE TICKET
    const ticketCode = crypto.randomBytes(16).toString("hex");
    const qrCode = await generateQRCode(ticketCode);

    await Ticket.create({
      event: event._id,
      organizer: event.organizer,
      buyerEmail: email,
      qrCode: ticketCode,
      scanned: false,
      paymentRef: reference,
      amountPaid: payment.amount,
      ticketType,
      currency: "NGN",
    });

    // 💰 WALLET CREDIT
    const platformFee = Math.round(payment.amount * 0.03 + 80);
    const organizerAmount = payment.amount - platformFee;

    let wallet = await Wallet.findOne({ organizer: event.organizer });
    if (!wallet) {
      wallet = await Wallet.create({
        organizer: event.organizer,
        balance: 0,
        totalEarnings: 0,
      });
    }

    wallet.balance += organizerAmount;
    wallet.totalEarnings += organizerAmount;
    await wallet.save();

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return res.status(500).json({ received: false });
  }
};
