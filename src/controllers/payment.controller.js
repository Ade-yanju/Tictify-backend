import dotenv from "dotenv";
dotenv.config();
import crypto from "crypto";
import fetch from "node-fetch";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";

export const initiatePayment = async (req, res) => {
  try {
    const { eventId, ticketType, email } = req.body;

    if (!eventId || !ticketType || !email) {
      return res.status(400).json({ message: "Invalid request" });
    }

    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE") {
      return res.status(400).json({ message: "Event unavailable" });
    }

    const ticket = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticket) {
      return res.status(400).json({ message: "Invalid ticket type" });
    }

    const amount = Number(ticket.price);
    const reference = `TICTIFY-${crypto.randomBytes(8).toString("hex")}`;

    /* ================= FREE EVENT ================= */
    if (amount === 0) {
      await Payment.create({
        reference,
        event: eventId,
        organizer: event.organizer,
        ticketType,
        email,
        amount: 0,
        status: "SUCCESS",
        provider: "FREE",
      });

      return res.json({
        reference,
        paymentUrl: `${process.env.FRONTEND_URL}/payment/success?ref=${reference}`,
      });
    }

    /* ================= PAID EVENT ================= */
    await Payment.create({
      reference,
      event: eventId,
      organizer: event.organizer,
      ticketType,
      email,
      amount,
      status: "PENDING",
      provider: "ERCASPAY",
    });

    const ercaspayRes = await fetch(
      "https://api.ercaspay.com/payment/initiate",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ERCASPAY_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: amount * 100, // kobo
          paymentReference: reference,
          paymentMethods: "card,bank_transfer,ussd",
          customerEmail: email,
          currency: "NGN",
          redirectUrl: `${process.env.FRONTEND_URL}/payment/processing?ref=${reference}`,
          metadata: {
            eventId,
            ticketType,
            email,
          },
        }),
      },
    );

    const data = await ercaspayRes.json();

    if (!ercaspayRes.ok || !data?.data?.checkoutUrl) {
      console.error("ERCASPAY ERROR:", data);
      return res.status(500).json({ message: "Payment gateway error" });
    }

    return res.json({
      reference,
      paymentUrl: data.data.checkoutUrl,
    });
  } catch (err) {
    console.error("INIT PAYMENT ERROR:", err);
    res.status(500).json({ message: "Payment init failed" });
  }
};

export const verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;

    const payment = await Payment.findOne({ reference });
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }

    if (payment.status === "SUCCESS") {
      return res.json({ status: "SUCCESS" });
    }

    const verifyRes = await fetch(
      `https://api.ercaspay.com/payment/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.ERCASPAY_SECRET_KEY}`,
        },
      },
    );

    const verifyData = await verifyRes.json();

    if (verifyData?.data?.status !== "SUCCESSFUL") {
      return res.json({ status: "PENDING" });
    }

    /* ================= PAYMENT CONFIRMED ================= */
    payment.status = "SUCCESS";
    await payment.save();

    const event = await Event.findById(payment.event);

    const ticketCode = crypto.randomBytes(16).toString("hex");

    await Ticket.create({
      event: event._id,
      organizer: event.organizer,
      buyerEmail: payment.email,
      qrCode: ticketCode,
      ticketType: payment.ticketType,
      paymentRef: reference,
      amountPaid: payment.amount,
      currency: "NGN",
    });

    return res.json({ status: "SUCCESS" });
  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ status: "ERROR" });
  }
};
