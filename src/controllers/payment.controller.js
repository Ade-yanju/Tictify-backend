import crypto from "crypto";
import fetch from "node-fetch";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";

/* =====================================================
   INITIATE PAYMENT (FREE OR ERCASPAY)
===================================================== */
export const initiatePayment = async (req, res) => {
  try {
    const { eventId, ticketType, email } = req.body;

    /* ================= VALIDATION ================= */
    if (!eventId || !ticketType || !email) {
      return res.status(400).json({ message: "Invalid payment request" });
    }

    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE") {
      return res.status(400).json({ message: "Invalid or inactive event" });
    }

    const ticket = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticket) {
      return res.status(400).json({ message: "Invalid ticket type" });
    }

    const amount = Number(ticket.price);
    if (isNaN(amount) || amount < 0) {
      return res.status(400).json({ message: "Invalid ticket price" });
    }

    const reference = `TICTIFY-${crypto.randomBytes(10).toString("hex")}`;

    /* =====================================================
       FREE TICKET FLOW (NO ERCASPAY)
    ===================================================== */
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
        paymentUrl: `${process.env.FRONTEND_URL}/payment/free-success?ref=${reference}`,
        reference,
      });
    }

    /* =====================================================
       PAID TICKET FLOW (ERCASPAY)
    ===================================================== */

    // Save pending payment FIRST (important for webhook)
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
      "https://api.ercaspay.com/api/v1/payment/initiate",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ERCASPAY_SECRET_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          amount: amount * 100, // MUST be kobo
          currency: "NGN",

          paymentReference: reference, // ✅ REQUIRED
          customerEmail: email, // ✅ REQUIRED
          merchantId: process.env.ERCASPAY_MERCHANT_ID, // ✅ REQUIRED

          redirectUrl: `${process.env.FRONTEND_URL}/payment/processing`, // ✅ REQUIRED
          callbackUrl: `${process.env.BACKEND_URL}/api/webhooks/ercaspay`, // ✅ REQUIRED

          metadata: {
            eventId,
            ticketType,
            email,
          },
        }),
      },
    );

    const contentType = ercaspayRes.headers.get("content-type");
    const rawText = await ercaspayRes.text();

    if (!ercaspayRes.ok) {
      console.error("ERCASPAY HTTP ERROR:", rawText);
      await Payment.updateOne({ reference }, { status: "FAILED" });
      return res.status(500).json({
        message: "Payment gateway error",
      });
    }

    if (!contentType || !contentType.includes("application/json")) {
      console.error("ERCASPAY NON-JSON RESPONSE:", rawText);
      return res.status(500).json({
        message: "Invalid response from payment gateway",
      });
    }

    const ercaspayData = JSON.parse(rawText);

    if (!ercaspayData?.data?.checkout_url) {
      console.error("ERCASPAY INVALID PAYLOAD:", ercaspayData);
      return res.status(500).json({
        message: "Unable to initialize payment",
      });
    }

    return res.json({
      paymentUrl: ercaspayData.data.checkout_url,
      reference,
    });
  } catch (err) {
    console.error("INITIATE PAYMENT ERROR:", err);
    return res.status(500).json({ message: "Payment initialization failed" });
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

    return res.json({
      status: payment.status, // PENDING | SUCCESS | FAILED
    });
  } catch (err) {
    console.error("PAYMENT STATUS ERROR:", err);
    return res.status(500).json({ status: "ERROR" });
  }
};
