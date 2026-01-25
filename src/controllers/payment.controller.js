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

    const ticketConfig = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticketConfig) {
      return res.status(400).json({ message: "Invalid ticket type" });
    }

    const ticketPrice = Number(ticketConfig.price);
    if (isNaN(ticketPrice) || ticketPrice < 0) {
      return res.status(400).json({ message: "Invalid ticket price" });
    }

    const reference = `TICTIFY-${crypto.randomBytes(10).toString("hex")}`;

    /* =====================================================
       FREE EVENT (NO PAYMENT GATEWAY)
    ===================================================== */
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
      });

      return res.json({
        reference,
        paymentUrl: `${process.env.FRONTEND_URL}/success/${reference}`,
      });
    }

    /* =====================================================
       PAID EVENT (GUEST PAYS PLATFORM FEE)
    ===================================================== */
    const platformFee = Math.round(ticketPrice * 0.03 + 80);
    const totalAmount = ticketPrice + platformFee;

    await Payment.create({
      reference,
      event: eventId,
      organizer: event.organizer,
      ticketType,
      email,
      amount: totalAmount, // what guest pays
      platformFee,
      organizerAmount: ticketPrice, // what organizer earns
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
          amount: totalAmount, // ✅ NAIRA (NOT kobo)
          paymentReference: reference,
          paymentMethods: "card,bank-transfer,ussd,qrcode",
          customerName: name,
          customerEmail: email,
          currency: "NGN",
          redirectUrl: `${process.env.BACKEND_URL}/api/payments/callback?ref=${reference}`,
          metadata: {
            eventId,
            ticketType,
            email,
          },
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
   ERCASPAY CALLBACK (SOURCE OF TRUTH)
===================================================== */
export const paymentCallback = async (req, res) => {
  try {
    // ERCASPAY MAY NOT SEND ref CONSISTENTLY
    const ref =
      req.query.ref ||
      req.query.reference ||
      req.query.paymentReference;

    if (!ref) {
      // STILL redirect to success – frontend will handle waiting
      return res.redirect(`${process.env.FRONTEND_URL}/success`);
    }

    // DO NOT VERIFY HERE
    // DO NOT FAIL HERE
    // DO NOT BLOCK HERE

    return res.redirect(`${process.env.FRONTEND_URL}/success/${ref}`);
  } catch (err) {
    console.error("PAYMENT CALLBACK ERROR:", err);

    // NEVER FAIL REDIRECT
    return res.redirect(`${process.env.FRONTEND_URL}/success`);
  }
};
