import crypto from "crypto";
import fetch from "node-fetch";
import QRCode from "qrcode";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";

/* =====================================================
   INITIATE PAYMENT (FREE OR PAYSTACK)
===================================================== */
export const initiatePayment = async (req, res) => {
  try {
    const { eventId, ticketType, email, name } = req.body;

    if (!eventId || !ticketType || !email || !name) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const now = new Date();

    /* 1️⃣ LOAD EVENT */
    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE") {
      return res.status(400).json({ message: "Event unavailable" });
    }

    /* 2️⃣ TIME GUARDS */
    if (event.date <= now) {
      return res
        .status(400)
        .json({ message: "Ticket sales have closed for this event" });
    }

    if (event.endDate <= now) {
      event.status = "ENDED";
      await event.save();
      return res.status(400).json({ message: "This event has ended" });
    }

    /* 3️⃣ FIND TICKET TYPE */
    const ticketConfig = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticketConfig) {
      return res.status(400).json({ message: "Invalid ticket type" });
    }

    /* 4️⃣ ENFORCE QUANTITY */
    if (ticketConfig.sold >= ticketConfig.quantity) {
      return res.status(400).json({ message: "This ticket type is sold out" });
    }

    /* 5️⃣ ENFORCE EVENT CAPACITY */
    const totalSold = event.ticketTypes.reduce(
      (sum, t) => sum + (t.sold || 0),
      0,
    );
    if (totalSold >= event.capacity) {
      event.status = "ENDED";
      await event.save();
      return res.status(400).json({ message: "Event is sold out" });
    }

    const ticketPrice = Number(ticketConfig.price);
    const reference = `TICTIFY-${crypto.randomBytes(10).toString("hex")}`;

    /* ================= FREE EVENT ================= */
    if (ticketPrice === 0) {
      const qrCode = crypto.randomBytes(16).toString("hex");
      const qrImage = await QRCode.toDataURL(qrCode);

      ticketConfig.sold += 1;
      await event.save();

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

    /* ================= PAID EVENT (PAYSTACK) ================= */
    const platformFee = Math.round(ticketPrice * 0.03 + 80);
    const totalAmount = ticketPrice + platformFee;

    await Payment.create({
      reference,
      event: eventId,
      organizer: event.organizer, // ✅ always saved upfront
      ticketType,
      email,
      amount: totalAmount,
      platformFee,
      organizerAmount: ticketPrice,
      status: "PENDING",
      provider: "PAYSTACK",
    });

    const paystackRes = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: totalAmount * 100, // Kobo
          email,
          reference,
          currency: "NGN",
          callback_url: `${process.env.BACKEND_URL}/api/payments/callback`,
          metadata: { eventId, ticketType, email, customerName: name },
        }),
      },
    );

    const paystackData = await paystackRes.json();

    if (!paystackData.status || !paystackData.data?.authorization_url) {
      await Payment.updateOne({ reference }, { status: "FAILED" });
      return res
        .status(500)
        .json({ message: "Unable to initialize payment with Paystack" });
    }

    res.json({ reference, paymentUrl: paystackData.data.authorization_url });
  } catch (err) {
    console.error("INITIATE PAYMENT ERROR:", err);
    res.status(500).json({ message: "Payment initialization failed" });
  }
};

/* =====================================================
   PAYSTACK CALLBACK & VERIFICATION
===================================================== */
export const paymentCallback = async (req, res) => {
  try {
    /* 1️⃣ Resolve reference */
    const rawCandidates = [
      req.query.reference,
      req.query.trxref,
      req.query.ref,
      req.params?.reference,
    ].filter(Boolean);

    let reference = null;
    for (const value of rawCandidates) {
      const cleaned = String(value).split("?")[0].split("&")[0];
      if (cleaned.startsWith("TICTIFY-")) {
        reference = cleaned;
        break;
      }
    }

    if (!reference) {
      console.error("❌ Could not resolve payment reference");
      return res.redirect(`${process.env.FRONTEND_URL}/success`);
    }

    /* 2️⃣ Verify with Paystack */
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      },
    );
    const verifyData = await verifyRes.json();

    if (!verifyData.status || verifyData.data.status !== "success") {
      console.warn(`⚠️ Unsuccessful payment for ref: ${reference}`);
      await Payment.updateOne({ reference }, { status: "FAILED" });
      return res.redirect(`${process.env.FRONTEND_URL}/payment-failed`);
    }

    /* 3️⃣ Find or recover payment record */
    let payment = await Payment.findOne({ reference });

    if (!payment) {
      // Fallback: payment record missing — recover from Paystack metadata + event
      console.warn(
        "⚠️ Payment not found in DB, recovering from Paystack metadata",
      );
      const { metadata } = verifyData.data;
      const fallbackEvent = await Event.findById(metadata.eventId);

      payment = await Payment.create({
        reference,
        event: metadata.eventId,
        organizer: fallbackEvent?.organizer ?? null, // ✅ always populate organizer
        ticketType: metadata.ticketType,
        email: metadata.email,
        amount: verifyData.data.amount / 100,
        platformFee: 0,
        organizerAmount: verifyData.data.amount / 100,
        status: "SUCCESS",
        provider: "PAYSTACK",
      });
    } else if (payment.status !== "SUCCESS") {
      payment.status = "SUCCESS";
      await payment.save();
    }

    /* 4️⃣ Idempotency guard — skip if ticket already exists */
    const existingTicket = await Ticket.findOne({ paymentRef: reference });
    if (existingTicket) {
      // Already processed (e.g. duplicate callback) — just redirect
      return res.redirect(`${process.env.FRONTEND_URL}/success/${reference}`);
    }

    /* 5️⃣ Generate ticket */
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
      amountPaid: payment.organizerAmount,
      currency: "NGN",
      scanned: false,
    });

    /* 6️⃣ Update event capacity */
    const event = await Event.findById(payment.event);
    if (event) {
      const ticketConfig = event.ticketTypes.find(
        (t) => t.name === payment.ticketType,
      );
      if (ticketConfig) ticketConfig.sold += 1;

      const totalSold = event.ticketTypes.reduce(
        (sum, t) => sum + (t.sold || 0),
        0,
      );
      if (totalSold >= event.capacity) event.status = "ENDED";

      await event.save();
    }

    /* 7️⃣ Credit organizer wallet ✅ */
    await Wallet.findOneAndUpdate(
      { organizer: payment.organizer },
      {
        $inc: {
          balance: payment.organizerAmount,
          totalEarnings: payment.organizerAmount,
        },
        $setOnInsert: { organizer: payment.organizer },
      },
      { upsert: true },
    );

    console.log(`✅ Payment processed & wallet credited: ${reference}`);
    return res.redirect(`${process.env.FRONTEND_URL}/success/${reference}`);
  } catch (err) {
    console.error("PAYMENT CALLBACK ERROR:", err);
    return res.redirect(`${process.env.FRONTEND_URL}/success`);
  }
};

/* =====================================================
   VERIFY PAYMENT (POLLING FALLBACK)
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
