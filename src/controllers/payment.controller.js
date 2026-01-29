import crypto from "crypto";
import fetch from "node-fetch";
import QRCode from "qrcode";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";

/* =====================================================
   INITIATE PAYMENT (FREE OR ERCASPAY)
===================================================== */
export const initiatePayment = async (req, res) => {
  try {
    const { eventId, ticketType, email, name } = req.body;

    if (!eventId || !ticketType || !email || !name) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE") {
      return res.status(400).json({ message: "Event unavailable" });
    }

    const ticketConfig = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticketConfig) {
      return res.status(400).json({ message: "Invalid ticket type" });
    }

    const ticketPrice = Number(ticketConfig.price);
    if (isNaN(ticketPrice) || ticketPrice < 0) {
      return res.status(400).json({ message: "Invalid ticket price" });
    }

    const reference = `TICTIFY-${crypto.randomBytes(10).toString("hex")}`;

    /* ================= FREE EVENT ================= */
    if (ticketPrice === 0) {
      await Payment.create({
        reference,
        event: eventId,
        organizer: event.organizer,
        ticketType,
        email,
        amount: 0,
        platformFee: 0,
        organizerAmount: 0,
        status: "SUCCESS",
        provider: "FREE",
      });

      await Ticket.create({
        event: event._id,
        organizer: event.organizer,
        buyerEmail: email,
        qrCode: crypto.randomBytes(16).toString("hex"),
        ticketType,
        paymentRef: reference,
        amountPaid: 0,
        currency: "NGN",
        scanned: false,
      });

      return res.json({
        reference,
        paymentUrl: `${process.env.FRONTEND_URL}/success/${reference}`,
      });
    }

    /* ================= PAID EVENT ================= */
    const platformFee = Math.round(ticketPrice * 0.03 + 80);
    const totalAmount = ticketPrice + platformFee;

    await Payment.create({
      reference,
      event: eventId,
      organizer: event.organizer,
      ticketType,
      email,
      amount: totalAmount,
      platformFee,
      organizerAmount: ticketPrice,
      status: "PENDING",
      provider: "ERCASPAY",
    });

    const ercaspayRes = await fetch(
      "https://api.ercaspay.com/api/v1/payment/initiate",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ERCASPAY_SECRET_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          amount: totalAmount,
          paymentReference: reference,
          paymentMethods: "card,bank-transfer,ussd,qrcode",
          customerName: name,
          customerEmail: email,
          currency: "NGN",
          redirectUrl: `${process.env.BACKEND_URL}/api/payments/callback?ref=${reference}`,
          metadata: { eventId, ticketType, email },
        }),
      },
    );

    const ercaspayData = await ercaspayRes.json();

    if (
      ercaspayData?.requestSuccessful !== true ||
      !ercaspayData?.responseBody?.checkoutUrl
    ) {
      await Payment.updateOne({ reference }, { status: "FAILED" });
      return res.status(500).json({ message: "Unable to initialize payment" });
    }

    return res.json({
      reference,
      paymentUrl: ercaspayData.responseBody.checkoutUrl,
    });
  } catch (err) {
    console.error("INITIATE PAYMENT ERROR:", err);
    return res.status(500).json({ message: "Payment initialization failed" });
  }
};

/* =====================================================
   ERCASPAY CALLBACK — FORCE SUCCESS (SOURCE OF TRUTH)
===================================================== */
export const paymentCallback = async (req, res) => {
  try {
    const reference =
      req.query.ref || req.query.reference || req.query.paymentReference;

    if (!reference) {
      return res.redirect(`${process.env.FRONTEND_URL}/success`);
    }

    const payment = await Payment.findOne({ reference });
    if (!payment) {
      return res.redirect(`${process.env.FRONTEND_URL}/success/${reference}`);
    }

    /* 🔥 FORCE SUCCESS */
    if (payment.status !== "SUCCESS") {
      payment.status = "SUCCESS";
      await payment.save();
    }

    /* 🔥 CREATE TICKET IMMEDIATELY */
    let ticket = await Ticket.findOne({ paymentRef: reference });

    if (!ticket) {
      ticket = await Ticket.create({
        event: payment.event,
        organizer: payment.organizer,
        buyerEmail: payment.email,
        qrCode: crypto.randomBytes(16).toString("hex"),
        ticketType: payment.ticketType,
        paymentRef: reference,
        amountPaid: payment.organizerAmount,
        currency: "NGN",
        scanned: false,
      });
    }

    return res.redirect(`${process.env.FRONTEND_URL}/success/${reference}`);
  } catch (err) {
    console.error("PAYMENT CALLBACK ERROR:", err);
    return res.redirect(`${process.env.FRONTEND_URL}/success`);
  }
};

/* =====================================================
   VERIFY PAYMENT (OPTIONAL FALLBACK ONLY)
===================================================== */
export const verifyPayment = async (req, res) => {
  const { reference } = req.body;
  const payment = await Payment.findOne({ reference });

  if (!payment) {
    return res.json({ success: false });
  }

  if (payment.status === "SUCCESS") {
    return res.json({ success: true });
  }

  return res.json({ success: false });
};

/* =====================================================
   GET TICKET BY REFERENCE
===================================================== */
export const getTicketByReference = async (req, res) => {
  const { reference } = req.params;

  const ticket = await Ticket.findOne({
    paymentRef: reference,
  }).populate("event");

  if (!ticket) {
    return res.json({ status: "PENDING" });
  }

  const qrImage = await QRCode.toDataURL(ticket.qrCode);

  return res.json({
    status: "READY",
    event: {
      title: ticket.event.title,
      date: ticket.event.date,
      location: ticket.event.location,
    },
    ticket: {
      ticketType: ticket.ticketType,
      qrImage,
    },
  });
};
