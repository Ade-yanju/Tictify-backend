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
      "https://api.ercaspay.com/api/v1/payments",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ERCASPAY_SECRET_KEY}`,
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
      },
    );

    const ercaspayData = await ercaspayRes.json();

    if (!ercaspayRes.ok || !ercaspayData?.data?.checkout_url) {
      console.error("ERCASPAY INIT FAILED:", ercaspayData);

      // Mark payment as FAILED
      await Payment.updateOne({ reference }, { status: "FAILED" });

      return res.status(500).json({
        message: "Unable to initialize payment",
      });
    }

    return res.json({
      paymentUrl: ercaspayData.data.checkout_url,
      reference,
    });
  } catch (err) {
    console.error("PAYMENT INIT ERROR:", err);
    return res.status(500).json({ message: "Unable to initialize payment" });
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
