import crypto from "crypto";
import fetch from "node-fetch";
import QRCode from "qrcode";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import { salesCloseAt } from "./event.controller.js";
import { resolveDiscount } from "./discount.controller.js";
import { emailTicketToGuest } from "./webhook.controller.js";
import {
  whatsappConfigured,
  deliverTicketToWhatsApp,
} from "../services/whatsapp.service.js";

/* =====================================================
   PAYMENT-METHOD CAPABILITY
   Paystack only provisions dedicated transfer accounts for
   accounts where that feature is enabled. Offering it when
   it isn't produces an instantly-FAILED payment and a guest
   who can't buy — so the first refusal switches it off for
   everyone until the TTL lapses, and the checkout stops
   showing it. Re-probes itself an hour later, so enabling
   the feature on Paystack needs no redeploy.
===================================================== */
const TRANSFER_RECHECK_MS = 60 * 60 * 1000;
let transferUnavailableSince = 0;

export function markTransferUnavailable() {
  transferUnavailableSince = Date.now();
}

export function transferAvailable() {
  if (!transferUnavailableSince) return true;
  return Date.now() - transferUnavailableSince > TRANSFER_RECHECK_MS;
}

/* Public: what the checkout may offer right now */
export const getPaymentMethods = (req, res) =>
  res.json({ card: true, transfer: transferAvailable() });

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
   CREATE PAYMENT SESSION (FREE OR PAYSTACK)
   Shared core used by BOTH the HTTP controller below and
   the WhatsApp bot. Never throws — returns:
     { ok:true,  free, reference, paymentUrl, ...feeBreakdown }
     { ok:false, status, message }
===================================================== */
export async function createPaymentSession({
  eventId,
  ticketType,
  quantity,
  name,
  email,
  promoter: rawPromoter,
  discountCode: rawDiscountCode,
  waPhone: rawWaPhone,
  /* "link" (default, Paystack checkout URL — the web always uses this)
     or "transfer" (dedicated bank account via the Charge API, used by
     the WhatsApp bot so guests can pay without leaving the chat) */
  payMethod = "link",
}) {
  try {
    const promoter = sanitizePromoter(rawPromoter);
    /* WhatsApp buyer phone rides along ONLY when it's a sane
       international number — the webhook uses it for QR delivery. */
    const waPhone = /^\d{10,15}$/.test(String(rawWaPhone || ""))
      ? String(rawWaPhone)
      : undefined;

    if (!eventId || !ticketType || !email || !name) {
      return { ok: false, status: 400, message: "Missing required fields" };
    }

    const now = new Date();

    /* 1️⃣ LOAD EVENT */
    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE") {
      return { ok: false, status: 400, message: "Event unavailable" };
    }

    /* 2️⃣ TIME GUARDS */
    /* Sales run until salesCloseAt (defaults to endDate) — NOT until the
       event starts. This is what the event page advertises via isSelling,
       and it's what lets organizers sell at the door. */
    if (salesCloseAt(event) <= now) {
      return {
        ok: false,
        status: 400,
        message: "Ticket sales have closed for this event",
      };
    }

    if (event.endDate <= now) {
      event.status = "ENDED";
      await event.save();
      return { ok: false, status: 400, message: "This event has ended" };
    }

    /* 3️⃣ FIND TICKET TYPE */
    const ticketConfig = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticketConfig) {
      return { ok: false, status: 400, message: "Invalid ticket type" };
    }

    /* 4️⃣ ENFORCE QUANTITY (buyer can take 1-10 tickets per order) */
    const qty = Math.min(10, Math.max(1, parseInt(quantity) || 1));
    const tierRemaining = ticketConfig.quantity - (ticketConfig.sold || 0);
    if (tierRemaining < qty) {
      return {
        ok: false,
        status: 400,
        message:
          tierRemaining <= 0
            ? "This ticket type is sold out"
            : `Only ${tierRemaining} ${ticketType} ticket${tierRemaining > 1 ? "s" : ""} left`,
      };
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
      return {
        ok: false,
        status: 400,
        message:
          left === 0 ? "Event is sold out" : `Only ${left} spots left for this event`,
      };
    }

    const ticketPrice = effectivePrice(ticketConfig);
    const reference = `TICTIFY-${crypto.randomBytes(10).toString("hex")}`;

    /* Discount code: validate + atomically consume one use */
    let discountAmount = 0;
    let discountCode;
    let claimedDiscountId; // so a failed transfer attempt can return the use
    if (rawDiscountCode) {
      const d = await resolveDiscount(event._id, rawDiscountCode);
      if (!d) {
        return {
          ok: false,
          status: 400,
          message: "Invalid or exhausted discount code",
        };
      }
      const { default: DiscountCode } = await import("../models/DiscountCode.js");
      const claimed = await DiscountCode.findOneAndUpdate(
        { _id: d._id, active: true, $expr: { $lt: ["$uses", "$maxUses"] } },
        { $inc: { uses: 1 } },
        { new: true },
      );
      if (!claimed) {
        return { ok: false, status: 400, message: "Discount code just sold out" };
      }
      discountCode = claimed.code;
      claimedDiscountId = claimed._id;
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
        waPhone,
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

      // 📧 ticket lands in their inbox automatically (fire-and-forget)
      emailTicketToGuest(reference);

      // 📲 WhatsApp buyers get the QR in the chat too (fire-and-forget)
      if (waPhone && whatsappConfigured) {
        deliverTicketToWhatsApp({
          phone: waPhone,
          eventTitle: event.title,
          reference,
        }).catch(console.error);
      }

      return {
        ok: true,
        free: true,
        reference,
        paymentUrl: `${process.env.FRONTEND_URL}/success/${reference}`,
        quantity: qty,
        unitPrice: 0,
        subtotal: 0,
        discountAmount: 0,
        platformFee: 0,
        processingFee: 0,
        total: 0,
      };
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
      waPhone,
      status: "PENDING",
      provider: "PAYSTACK",
    });

    /* ── PAY BY BANK TRANSFER (Charge API — dedicated account) ──
       Confirmation needs no new code: Paystack fires the same
       charge.success webhook with this reference once the money
       lands, and the existing webhook path mints the ticket. */
    if (payMethod === "transfer") {
      try {
        const chargeRes = await fetch("https://api.paystack.co/charge", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email,
            amount: totalAmount * 100, // Kobo
            reference,
            bank_transfer: {},
            metadata: { eventId, ticketType, email, customerName: name },
          }),
        });
        const chargeData = await chargeRes.json();

        /* DEFENSIVE PARSE — the response shape varies by account/API
           revision, so probe every plausible path for the details. */
        const cd = chargeData?.data || {};
        const bt = cd.bank_transfer || {};
        const accountNumber =
          bt.account_number || cd.account_number || bt.bank?.account_number;
        const bankName =
          bt.bank?.name || cd.bank?.name || bt.bank_name || cd.bank_name;
        const accountName =
          bt.account_name || cd.account_name || bt.bank?.account_name;
        const expiresAt =
          bt.account_expires_at ||
          cd.account_expires_at ||
          bt.expires_at ||
          cd.expires_at;

        if (chargeData?.status && accountNumber) {
          return {
            ok: true,
            free: false,
            transfer: true,
            reference,
            accountNumber,
            bankName,
            accountName,
            expiresAt,
            quantity: qty,
            unitPrice: ticketPrice,
            subtotal,
            discountAmount,
            platformFee,
            processingFee: fees.processingFee,
            total: totalAmount,
          };
        }
        console.error(
          "PAYSTACK TRANSFER CHARGE UNPARSEABLE:",
          JSON.stringify(chargeData).slice(0, 300),
        );
      } catch (err) {
        console.error("PAYSTACK TRANSFER CHARGE ERROR:", err.message);
      }

      /* Transfer unavailable (feature disabled / API error / shape we
         can't parse) → void this attempt so the caller can retry via
         the normal link path with a fresh reference. */
      markTransferUnavailable();
      await Payment.updateOne({ reference }, { status: "FAILED" });
      if (claimedDiscountId) {
        // return the discount use consumed by this dead attempt
        const { default: DiscountCode } = await import("../models/DiscountCode.js");
        await DiscountCode.updateOne(
          { _id: claimedDiscountId, uses: { $gt: 0 } },
          { $inc: { uses: -1 } },
        ).catch(() => {});
      }
      return {
        ok: false,
        status: 502,
        transferUnavailable: true,
        message: "Bank transfer isn't available right now",
      };
    }

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
          callback_url: `${process.env.BACKEND_URL || "https://tictify-backend.onrender.com"}/api/payments/callback`,
          metadata: { eventId, ticketType, email, customerName: name },
        }),
      },
    );

    const paystackData = await paystackRes.json();

    if (!paystackData.status || !paystackData.data?.authorization_url) {
      await Payment.updateOne({ reference }, { status: "FAILED" });
      return {
        ok: false,
        status: 500,
        message: "Unable to initialize payment with Paystack",
      };
    }

    return {
      ok: true,
      free: false,
      reference,
      paymentUrl: paystackData.data.authorization_url,
      quantity: qty,
      unitPrice: ticketPrice,
      subtotal,
      discountAmount,
      platformFee,
      processingFee: fees.processingFee,
      total: totalAmount,
    };
  } catch (err) {
    console.error("INITIATE PAYMENT ERROR:", err);
    return { ok: false, status: 500, message: "Payment initialization failed" };
  }
}

/* =====================================================
   INITIATE PAYMENT (HTTP) — thin wrapper over the shared core
===================================================== */
export const initiatePayment = async (req, res) => {
  const result = await createPaymentSession({
    eventId: req.body.eventId,
    ticketType: req.body.ticketType,
    quantity: req.body.quantity,
    name: req.body.name,
    email: req.body.email,
    promoter: req.body.promoter,
    discountCode: req.body.discountCode,
    waPhone: req.body.waPhone,
    /* Default "link" — callers that don't ask for transfer are unaffected */
    payMethod: req.body.payMethod === "transfer" ? "transfer" : "link",
  });

  if (!result.ok) {
    /* Transfer couldn't be provisioned — NOT an error the guest should
       see. 200 lets the client transparently retry on the card path. */
    if (result.transferUnavailable) {
      return res.json({ transferUnavailable: true });
    }
    return res.status(result.status || 500).json({ message: result.message });
  }

  if (result.transfer) {
    return res.json({
      transfer: true,
      reference: result.reference,
      accountNumber: result.accountNumber,
      bankName: result.bankName,
      accountName: result.accountName,
      expiresAt: result.expiresAt,
      total: result.total,
    });
  }

  return res.json({ reference: result.reference, paymentUrl: result.paymentUrl });
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

    // 📧 ticket email — only this path created the ticket (the webhook
    // skips creation when it already exists), so no duplicate sends
    emailTicketToGuest(reference);

    // 📲 WhatsApp buyers also get the QR in the chat (fire-and-forget)
    if (payment.waPhone && whatsappConfigured) {
      deliverTicketToWhatsApp({
        phone: payment.waPhone,
        eventTitle: event?.title,
        reference,
      }).catch(console.error);
    }

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
