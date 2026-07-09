import crypto from "crypto";
import fetch from "node-fetch";
import QRCode from "qrcode";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import { resolveDiscount } from "./discount.controller.js";

/* Early-bird: a tier can carry a cheaper price until a cutoff */
export function effectivePrice(tier, at = new Date()) {
  if (
    tier &&
    tier.earlyBirdPrice != null &&
    tier.earlyBirdPrice >= 0 &&
    tier.earlyBirdUntil &&
    new Date(tier.earlyBirdUntil) > at
  ) {
    return Number(tier.earlyBirdPrice);
  }
  return Number(tier?.price || 0);
}

/* =====================================================
   FEES
   - Platform fee (Tictify): 3% + ₦80 — funds the product
   - Processing fee (Paystack): 1.5% + ₦100 (₦100 waived
     under ₦2,500), capped at ₦2,000 — paid by the GUEST
     so the organizer always receives the full ticket price.
===================================================== */
export function computeFees(ticketPrice) {
  const platformFee = Math.round(ticketPrice * 0.03 + 80);
  const base = ticketPrice + platformFee;
  let processingFee = Math.round(base * 0.015) + (base >= 2500 ? 100 : 0);
  processingFee = Math.min(processingFee, 2000);
  return {
    ticketPrice,
    platformFee,
    processingFee,
    total: ticketPrice + platformFee + processingFee,
  };
}

/* Public quote — checkout shows this exact breakdown.
   qty (1-10) multiplies the ticket price; fees are computed once
   on the ORDER subtotal, so buying 3 tickets in one go is cheaper
   than three separate checkouts. */
export const quoteFees = async (req, res) => {
  try {
    const price = Number(req.query.price);
    const qty = Math.min(10, Math.max(1, parseInt(req.query.qty) || 1));
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ message: "Invalid price" });
    }
    if (price === 0) {
      return res.json({
        ticketPrice: 0, quantity: qty, subtotal: 0,
        platformFee: 0, processingFee: 0, total: 0,
      });
    }
    /* When eventId+ticketType are supplied, the server resolves the
       real (early-bird aware) unit price and any discount code —
       the client-supplied price is ignored. */
    let unit = Math.round(price);
    let discountAmount = 0;
    let discountApplied = null;
    const { eventId, ticketType, code } = req.query;
    if (eventId && ticketType) {
      const ev = await Event.findById(eventId);
      const tier = ev?.ticketTypes.find((t) => t.name === ticketType);
      if (tier) unit = effectivePrice(tier);
      if (ev && code) {
        const d = await resolveDiscount(ev._id, code);
        if (d) {
          discountApplied = { code: d.code, percentOff: d.percentOff };
        } else {
          return res.status(404).json({ message: "Invalid or exhausted discount code" });
        }
      }
    }

    let subtotal = unit * qty;
    if (discountApplied) {
      discountAmount = Math.round((subtotal * discountApplied.percentOff) / 100);
      subtotal -= discountAmount;
    }
    if (subtotal <= 0) {
      return res.json({ ticketPrice: unit, quantity: qty, subtotal: 0, discountAmount,
        discount: discountApplied, platformFee: 0, processingFee: 0, total: 0 });
    }
    const fees = computeFees(subtotal);
    return res.json({
      ticketPrice: unit,
      quantity: qty,
      subtotal,
      discountAmount,
      discount: discountApplied,
      platformFee: fees.platformFee,
      processingFee: fees.processingFee,
      total: fees.total,
    });
  } catch {
    return res.status(500).json({ message: "Quote failed" });
  }
};

/* Promoter codes ride along on shared links (?ref=CODE) */
function sanitizePromoter(raw) {
  const code = String(raw || "").trim().toUpperCase();
  return /^[A-Z0-9_-]{2,30}$/.test(code) ? code : undefined;
}

/* =====================================================
   INITIATE PAYMENT (FREE OR PAYSTACK)
===================================================== */
export const initiatePayment = async (req, res) => {
  try {
    const { eventId, ticketType, email, name } = req.body;
    const promoter = sanitizePromoter(req.body.promoter);

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

    /* 4️⃣ ENFORCE QUANTITY (buyer can take 1-10 tickets per order) */
    const qty = Math.min(10, Math.max(1, parseInt(req.body.quantity) || 1));
    const tierRemaining = ticketConfig.quantity - (ticketConfig.sold || 0);
    if (tierRemaining < qty) {
      return res.status(400).json({
        message:
          tierRemaining <= 0
            ? "This ticket type is sold out"
            : `Only ${tierRemaining} ${ticketType} ticket${tierRemaining > 1 ? "s" : ""} left`,
      });
    }

    /* 5️⃣ ENFORCE EVENT CAPACITY */
    const totalSold = event.ticketTypes.reduce(
      (sum, t) => sum + (t.sold || 0),
      0,
    );
    if (totalSold + qty > event.capacity) {
      const left = Math.max(0, event.capacity - totalSold);
      if (left === 0) {
        event.status = "ENDED";
        await event.save();
      }
      return res.status(400).json({
        message: left === 0 ? "Event is sold out" : `Only ${left} spots left for this event`,
      });
    }

    const ticketPrice = effectivePrice(ticketConfig);
    const reference = `TICTIFY-${crypto.randomBytes(10).toString("hex")}`;

    /* Discount code: validate + atomically consume one use */
    let discountAmount = 0;
    let discountCode;
    if (req.body.discountCode) {
      const d = await resolveDiscount(event._id, req.body.discountCode);
      if (!d) {
        return res.status(400).json({ message: "Invalid or exhausted discount code" });
      }
      const { default: DiscountCode } = await import("../models/DiscountCode.js");
      const claimed = await DiscountCode.findOneAndUpdate(
        { _id: d._id, active: true, $expr: { $lt: ["$uses", "$maxUses"] } },
        { $inc: { uses: 1 } },
        { new: true },
      );
      if (!claimed) {
        return res.status(400).json({ message: "Discount code just sold out" });
      }
      discountCode = claimed.code;
      discountAmount = Math.round((ticketPrice * qty * claimed.percentOff) / 100);
    }

    /* ================= FREE EVENT ================= */
    if (ticketPrice === 0) {
      const qrCode = crypto.randomBytes(16).toString("hex");
      const qrImage = await QRCode.toDataURL(qrCode);

      ticketConfig.sold += qty;
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
        promoter,
        quantity: qty,
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
        // one QR admits (tickets bought × people per ticket)
        groupSize: qty * Math.max(1, ticketConfig.groupSize || 1),
        admittedCount: 0,
      });

      return res.json({
        reference,
        paymentUrl: `${process.env.FRONTEND_URL}/success/${reference}`,
      });
    }

    /* ================= PAID EVENT (PAYSTACK) ================= */
    // Fees are computed once on the ORDER subtotal (price × qty − discount)
    const subtotal = ticketPrice * qty - discountAmount;
    const fees = computeFees(subtotal);
    const platformFee = fees.platformFee;
    const totalAmount = fees.total;

    await Payment.create({
      reference,
      event: eventId,
      organizer: event.organizer, // ✅ always saved upfront
      ticketType,
      email,
      amount: totalAmount,
      platformFee,
      processingFee: fees.processingFee,
      organizerAmount: subtotal,
      promoter,
      quantity: qty,
      discountCode,
      discountAmount,
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

    /* 6️⃣ Update event capacity + resolve group size */
    const event = await Event.findById(payment.event);
    const tierConfig = event?.ticketTypes.find(
      (t) => t.name === payment.ticketType,
    );

    const paidQty = Math.max(1, payment.quantity || 1);
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
      groupSize: paidQty * Math.max(1, tierConfig?.groupSize || 1),
      admittedCount: 0,
    });

    if (event) {
      const ticketConfig = tierConfig;
      if (ticketConfig) ticketConfig.sold += paidQty;

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

    // 💸 Ambassador 5% commission (non-blocking, idempotent)
    import("../services/commission.service.js")
      .then(({ creditAmbassadorCommission }) =>
        creditAmbassadorCommission(payment),
      )
      .catch(() => {});
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
