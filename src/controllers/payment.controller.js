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
      const qrCode = crypto.randomBytes(16).toString("hex");
      const qrImage = await QRCode.toDataURL(qrCode);

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
        qrCode,
        qrImage,
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

    // 🔒 ALWAYS CREATE PAYMENT FIRST
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
   ERCASPAY CALLBACK — FINAL SOURCE OF TRUTH
===================================================== */
export const paymentCallback = async (req, res) => {
  try {
    // 1️⃣ Collect all possible reference candidates
    const rawCandidates = [
      req.query.ref,
      req.query.reference,
      req.query.paymentReference,
      req.query.tx_reference,
      req.query.trxref,
      req.params?.reference,
      req.originalUrl,
    ].filter(Boolean);

    // 2️⃣ Sanitize candidates
    let reference = null;

    for (const value of rawCandidates) {
      // Convert to string and strip query params
      const cleaned = String(value).split("?")[0].split("&")[0];

      if (cleaned.startsWith("TICTIFY-")) {
        reference = cleaned;
        break;
      }
    }

    if (!reference) {
      console.error("❌ Could not resolve payment reference", {
        query: req.query,
        params: req.params,
        url: req.originalUrl,
      });

      return res.redirect(`${process.env.FRONTEND_URL}/success`);
    }

    // 3️⃣ Find or create payment (IDEMPOTENT)
    let payment = await Payment.findOne({ reference });

    if (!payment) {
      console.warn("⚠️ Payment not found, creating fallback:", reference);

      payment = await Payment.create({
        reference,
        status: "SUCCESS",
        provider: "ERCASPAY",
        amount: 0,
        platformFee: 0,
        organizerAmount: 0,
      });
    } else if (payment.status !== "SUCCESS") {
      payment.status = "SUCCESS";
      await payment.save();
    }

    // 4️⃣ Ensure ticket exists
    let ticket = await Ticket.findOne({ paymentRef: reference });

    if (!ticket) {
      const qrCode = crypto.randomBytes(16).toString("hex");
      const qrImage = await QRCode.toDataURL(qrCode);

      await Ticket.create({
        event: payment.event,
        organizer: payment.organizer,
        buyerEmail: payment.email,
        qrCode,
        qrImage,
        ticketType: payment.ticketType,
        paymentRef: reference,
        amountPaid: payment.organizerAmount || 0,
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
   VERIFY PAYMENT (SAFE FALLBACK)
===================================================== */
export const verifyPayment = async (req, res) => {
  const { reference } = req.body;

  const payment = await Payment.findOne({ reference });
  if (!payment) return res.json({ success: false });

  return res.json({ success: payment.status === "SUCCESS" });
};

/* =====================================================
   GET TICKET BY REFERENCE (READ ONLY)
===================================================== */
export const getTicketByReference = async (req, res) => {
  try {
    const { reference } = req.params;

    const ticket = await Ticket.findOne({ paymentRef: reference }).populate(
      "event",
    );

    if (!ticket || !ticket.qrImage) {
      return res.json({ status: "PENDING" });
    }

    return res.json({
      status: "READY",
      event: {
        title: ticket.event.title,
        date: ticket.event.date,
        location: ticket.event.location,
      },
      ticket: {
        ticketType: ticket.ticketType,
        qrImage: ticket.qrImage,
      },
    });
  } catch (err) {
    console.error("GET TICKET ERROR:", err);
    return res.status(500).json({ status: "ERROR" });
  }
};
