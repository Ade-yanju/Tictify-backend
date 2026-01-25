import crypto from "crypto";
import fetch from "node-fetch";
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

    const ticket = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticket) {
      return res.status(400).json({ message: "Invalid ticket type" });
    }

    const amount = Number(ticket.price);
    const reference = `TICTIFY-${crypto.randomBytes(10).toString("hex")}`;

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
        paymentUrl: `${process.env.FRONTEND_URL}/payment/success?ref=${reference}`,
        reference,
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

    const payload = {
      amount: amount, // ERCASPAY expects NAIRA, not kobo
      paymentReference: reference,
      paymentMethods: "card,bank-transfer,ussd,qrcode",
      customerName: name,
      customerEmail: email,
      currency: "NGN",
      redirectUrl: `${process.env.FRONTEND_URL}/payment/processing?ref=${reference}`,
      metadata: {
        eventId,
        ticketType,
        email,
      },
    };

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
          amount: amount, // kobo
          paymentReference: reference,
          paymentMethods: "card,bank-transfer,ussd",
          customerName: name,
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

    const ercaspayData = await ercaspayRes.json();

    /* ✅ HARD VALIDATION */
    if (
      !ercaspayData ||
      ercaspayData.requestSuccessful !== true ||
      !ercaspayData.responseBody?.checkoutUrl
    ) {
      console.error("ERCASPAY INIT FAILED:", ercaspayData);
      await Payment.updateOne({ reference }, { status: "FAILED" });

      return res.status(500).json({
        message: "Unable to initialize payment",
      });
    }

    /* ✅ SUCCESS */
    return res.json({
      reference,
      paymentUrl: ercaspayData.responseBody.checkoutUrl,
    });
  } catch (err) {
    console.error("INITIATE ERROR:", err);
    return res.status(500).json({ message: "Payment initialization failed" });
  }
};

/* =====================================================
   VERIFY PAYMENT (PROCESSING PAGE)
===================================================== */
export const verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;

    const payment = await Payment.findOne({ reference });
    if (!payment) {
      return res.status(404).json({ status: "NOT_FOUND" });
    }

    if (payment.status === "SUCCESS") {
      return res.json({ status: "SUCCESS" });
    }

    const verifyRes = await fetch(
      `https://api.ercaspay.com/api/v1/payment/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.ERCASPAY_SECRET_KEY}`,
          Accept: "application/json",
        },
      },
    );

    const verifyData = await verifyRes.json();

    if (verifyData?.data?.status !== "SUCCESSFUL") {
      return res.json({ status: "PENDING" });
    }

    /* ===== PAYMENT CONFIRMED ===== */
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

/* =====================================================
   PAYMENT STATUS (FRONTEND POLLING)
===================================================== */
export const getPaymentStatus = async (req, res) => {
  try {
    const { reference } = req.params;

    if (!reference) {
      return res.status(400).json({ status: "INVALID_REFERENCE" });
    }

    const payment = await Payment.findOne({ reference });
    if (!payment) {
      return res.status(404).json({ status: "NOT_FOUND" });
    }

    return res.json({ status: payment.status });
  } catch (err) {
    console.error("PAYMENT STATUS ERROR:", err);
    return res.status(500).json({ status: "ERROR" });
  }
};
