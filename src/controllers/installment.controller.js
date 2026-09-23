import crypto from "crypto";
import fetch from "node-fetch";
import InstallmentPlan from "../models/InstallmentPlan.js";
import Payment from "../models/Payment.js";
import DiscountCode from "../models/DiscountCode.js";
import Event from "../models/Event.js";
import { findEventByIdOrSlug } from "../utils/resolveEvent.js";
import { computeAvailability } from "../utils/availability.js";
import { effectivePrice } from "../utils/pricing.js";
import { computeFees, computeProcessingFee } from "../utils/paymentFees.js";
import {
  createInstallmentToken,
  hashInstallmentToken,
  reserveInstallmentTickets,
  releasePlanReservation,
  processInstallmentPayment,
  emailInstallmentPlanUpdate,
} from "../services/installment.service.js";
import { salesCloseAt } from "./event.controller.js";
import { resolveDiscount } from "./discount.controller.js";

const BACKEND = process.env.BACKEND_URL || "https://tictify-backend.onrender.com";
const FRONTEND = process.env.FRONTEND_URL || "https://tictify.vercel.app";

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function publicPlan(plan, token) {
  return {
    reference: plan.reference,
    event: plan.event,
    eventTitle: plan.eventTitle,
    name: plan.name,
    email: plan.email,
    ticketType: plan.ticketType,
    quantity: plan.quantity,
    groupSize: plan.groupSize,
    unitPrice: plan.unitPrice,
    discountAmount: plan.discountAmount,
    ticketSubtotal: plan.ticketSubtotal,
    platformFee: plan.platformFee,
    principalDue: plan.principalDue,
    amountPaid: plan.amountPaid,
    amountRemaining: plan.amountRemaining,
    status: plan.status,
    refundStatus: plan.refundStatus,
    refundedAt: plan.refundedAt,
    refundedAmount: plan.refundedAmount,
    dueAt: plan.dueAt,
    paymentCount: plan.paymentCount,
    paymentUrl: `${FRONTEND}/installments/${token}`,
  };
}

async function releaseFailedPlan(plan, discountId) {
  plan.status = "CANCELLED";
  plan.reservationReleasedAt = new Date();
  await releasePlanReservation(plan);
  await plan.save();
  if (discountId) {
    await DiscountCode.updateOne(
      { _id: discountId, uses: { $gt: 0 } },
      { $inc: { uses: -1 } },
    ).catch(() => {});
  }
}

export const initiateInstallment = async (req, res) => {
  let plan;
  let claimedDiscountId;
  let reservation;
  try {
    const {
      eventId,
      ticketType,
      quantity,
      name,
      discountCode: rawDiscountCode,
      promoter,
    } = req.body || {};
    const email = cleanEmail(req.body?.email);
    const guestName = String(name || "").trim();
    const waPhone = String(req.body?.waPhone || "").replace(/\D/g, "") || undefined;
    if (!eventId || !ticketType || !email || guestName.length < 2) {
      return res.status(400).json({ message: "Name, email, event and ticket type are required" });
    }

    const event = await findEventByIdOrSlug(eventId);
    if (!event || event.status !== "LIVE") {
      return res.status(400).json({ message: "Event unavailable" });
    }
    if (!event.installmentsEnabled) {
      return res.status(400).json({ message: "Installment payments are not enabled for this event" });
    }
    const now = new Date();
    if (salesCloseAt(event) <= now || event.date <= now) {
      return res.status(400).json({ message: "Installment reservations are closed for this event" });
    }
    if (!event.installmentDueAt || new Date(event.installmentDueAt) <= now) {
      return res.status(400).json({ message: "The installment deadline has passed" });
    }

    const tier = event.ticketTypes.find((item) => item.name === ticketType);
    if (!tier || effectivePrice(tier) <= 0) {
      return res.status(400).json({ message: "Installments are only available for paid tickets" });
    }

    const qty = Math.min(10, Math.max(1, parseInt(quantity) || 1));
    const availability = computeAvailability(event);
    const availableTier = availability.tiers.find((item) => item.name === ticketType);
    if (availableTier?.soldOut || (availableTier?.remaining > 0 && availableTier.remaining < qty)) {
      return res.status(400).json({ message: "There are not enough tickets left for this reservation" });
    }

    let discountAmount = 0;
    let discountCode;
    if (rawDiscountCode) {
      const discount = await resolveDiscount(event._id, rawDiscountCode);
      if (!discount) return res.status(400).json({ message: "Invalid or exhausted discount code" });
      const claimed = await DiscountCode.findOneAndUpdate(
        { _id: discount._id, active: true, $expr: { $lt: ["$uses", "$maxUses"] } },
        { $inc: { uses: 1 } },
        { new: true },
      );
      if (!claimed) return res.status(400).json({ message: "Discount code just sold out" });
      claimedDiscountId = claimed._id;
      discountCode = claimed.code;
      discountAmount = Math.round((effectivePrice(tier) * qty * claimed.percentOff) / 100);
    }

    const subtotal = effectivePrice(tier) * qty - discountAmount;
    const fullFees = computeFees(subtotal);
    const principalDue = subtotal + fullFees.platformFee;
    const minimumPercent = Math.min(90, Math.max(10, Number(event.installmentMinimumPercent) || 30));
    const initialPrincipal = Math.min(
      principalDue,
      Math.max(1, Math.ceil((principalDue * minimumPercent) / 100)),
    );
    const initialProcessingFee = computeProcessingFee(initialPrincipal);
    const initialCharge = initialPrincipal + initialProcessingFee;

    const reservedEvent = await reserveInstallmentTickets(event._id, ticketType, qty);
    if (!reservedEvent) {
      if (claimedDiscountId) {
        await DiscountCode.updateOne(
          { _id: claimedDiscountId, uses: { $gt: 0 } },
          { $inc: { uses: -1 } },
        ).catch(() => {});
      }
      return res.status(409).json({ message: "Those tickets were just reserved by another guest" });
    }
    reservation = { eventId: event._id, ticketType, quantity: qty };

    const token = createInstallmentToken();
    const reference = `TICTIFY-INST-${crypto.randomBytes(10).toString("hex")}`;
    plan = await InstallmentPlan.create({
      reference,
      event: event._id,
      eventTitle: event.title,
      organizer: event.organizer,
      name: guestName,
      email,
      waPhone,
      ticketType,
      quantity: qty,
      groupSize: Math.max(1, tier.groupSize || 1),
      promoter: String(promoter || "").trim().toUpperCase() || undefined,
      unitPrice: effectivePrice(tier),
      discountCode,
      discountAmount,
      ticketSubtotal: subtotal,
      platformFee: fullFees.platformFee,
      principalDue,
      amountPaid: 0,
      amountRemaining: principalDue,
      dueAt: event.installmentDueAt,
      accessToken: token,
      accessTokenHash: hashInstallmentToken(token),
    });

    const paymentReference = `TICTIFY-${crypto.randomBytes(10).toString("hex")}`;
    await Payment.create({
      reference: paymentReference,
      event: event._id,
      eventTitle: event.title,
      organizer: event.organizer,
      ticketType,
      email,
      waPhone,
      amount: initialCharge,
      platformFee: fullFees.platformFee,
      processingFee: initialProcessingFee,
      organizerAmount: 0,
      promoter: String(promoter || "").trim().toUpperCase() || undefined,
      quantity: qty,
      discountCode,
      discountAmount,
      status: "PENDING",
      provider: "PAYSTACK",
      paymentType: "INSTALLMENT",
      installmentPlan: plan._id,
      installmentAmount: initialPrincipal,
      installmentNumber: 1,
      countsAsTicketSale: false,
    });

    const paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: initialCharge * 100,
        email,
        reference: paymentReference,
        currency: "NGN",
        callback_url: `${BACKEND}/api/payments/callback?installmentToken=${encodeURIComponent(token)}`,
        metadata: {
          eventId: String(event._id),
          ticketType,
          email,
          customerName: guestName,
          installmentPlan: String(plan._id),
          installmentAmount: initialPrincipal,
        },
      }),
    });
    const paystackData = await paystackRes.json();
    if (!paystackData.status || !paystackData.data?.authorization_url) {
      await Payment.updateOne({ reference: paymentReference }, { status: "FAILED" });
      await releaseFailedPlan(plan, claimedDiscountId);
      return res.status(502).json({ message: "Unable to initialize installment payment" });
    }

    return res.json({
      reference: paymentReference,
      paymentUrl: paystackData.data.authorization_url,
      planUrl: `${FRONTEND}/installments/${token}`,
      initialPayment: initialPrincipal,
      processingFee: initialProcessingFee,
      total: initialCharge,
      amountRemaining: principalDue,
      dueAt: event.installmentDueAt,
    });
  } catch (err) {
    console.error("INSTALLMENT INITIATE ERROR:", err);
    if (plan) await releaseFailedPlan(plan, claimedDiscountId).catch(() => {});
    else if (reservation) {
      const heldEvent = await Event.findById(reservation.eventId).catch(() => null);
      const heldTier = heldEvent?.ticketTypes.find((item) => item.name === reservation.ticketType);
      if (heldEvent && heldTier) {
        heldTier.reserved = Math.max(0, Number(heldTier.reserved || 0) - reservation.quantity);
        heldEvent.reservedTickets = Math.max(0, Number(heldEvent.reservedTickets || 0) - reservation.quantity);
        await heldEvent.save().catch(() => {});
      }
    }
    if (!plan && claimedDiscountId) {
      await DiscountCode.updateOne(
        { _id: claimedDiscountId, uses: { $gt: 0 } },
        { $inc: { uses: -1 } },
      ).catch(() => {});
    }
    return res.status(500).json({ message: "Could not start installment reservation" });
  }
};

export const getInstallmentPlan = async (req, res) => {
  try {
    const plan = await InstallmentPlan.findOne({
      accessTokenHash: hashInstallmentToken(req.params.token),
    }).populate("event", "title date endDate location banner bannerFit status");
    if (!plan) return res.status(404).json({ message: "Reservation not found" });
    return res.json({
      ...publicPlan(plan, req.params.token),
      event: plan.event,
    });
  } catch (err) {
    console.error("GET INSTALLMENT ERROR:", err);
    return res.status(500).json({ message: "Unable to load reservation" });
  }
};

export const payInstallment = async (req, res) => {
  try {
    const plan = await InstallmentPlan.findOne({
      accessTokenHash: hashInstallmentToken(req.params.token),
    }).populate("event", "title date status");
    if (!plan) return res.status(404).json({ message: "Reservation not found" });
    if (!["RESERVED", "PARTIALLY_PAID"].includes(plan.status)) {
      return res.status(400).json({ message: plan.status === "PAID" ? "This reservation is already fully paid" : "This reservation is no longer active" });
    }
    if (new Date(plan.dueAt) <= new Date() || new Date(plan.event.date) <= new Date()) {
      return res.status(400).json({ message: "The payment deadline has passed" });
    }

    const recentPending = await Payment.findOne({
      installmentPlan: plan._id,
      status: "PENDING",
      createdAt: { $gt: new Date(Date.now() - 20 * 60 * 1000) },
    });
    if (recentPending) {
      return res.status(409).json({ message: "A payment for this reservation is already processing" });
    }
    await Payment.updateMany(
      { installmentPlan: plan._id, status: "PENDING", createdAt: { $lte: new Date(Date.now() - 20 * 60 * 1000) } },
      { status: "FAILED" },
    );

    const requested = req.body?.amount == null || req.body.amount === ""
      ? plan.amountRemaining
      : Math.round(Number(req.body.amount));
    if (!Number.isInteger(requested) || requested < 1 || requested > plan.amountRemaining) {
      return res.status(400).json({ message: `Enter an amount between ₦1 and ₦${Number(plan.amountRemaining).toLocaleString()}` });
    }
    const processingFee = computeProcessingFee(requested);
    const chargeAmount = requested + processingFee;
    const installmentNumber = Number(plan.paymentCount || 0) + 1;
    const reference = `TICTIFY-${crypto.randomBytes(10).toString("hex")}`;
    await Payment.create({
      reference,
      event: plan.event._id,
      eventTitle: plan.event.title,
      organizer: plan.organizer,
      ticketType: plan.ticketType,
      email: plan.email,
      waPhone: plan.waPhone,
      amount: chargeAmount,
      processingFee,
      organizerAmount: 0,
      quantity: plan.quantity,
      promoter: plan.promoter,
      status: "PENDING",
      provider: "PAYSTACK",
      paymentType: "INSTALLMENT",
      installmentPlan: plan._id,
      installmentAmount: requested,
      installmentNumber,
      countsAsTicketSale: false,
    });

    const paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: chargeAmount * 100,
        email: plan.email,
        reference,
        currency: "NGN",
        callback_url: `${BACKEND}/api/payments/callback?installmentToken=${encodeURIComponent(req.params.token)}`,
        metadata: {
          eventId: String(plan.event._id),
          ticketType: plan.ticketType,
          email: plan.email,
          customerName: plan.name,
          installmentPlan: String(plan._id),
          installmentAmount: requested,
        },
      }),
    });
    const data = await paystackRes.json();
    if (!data.status || !data.data?.authorization_url) {
      await Payment.updateOne({ reference }, { status: "FAILED" });
      return res.status(502).json({ message: "Unable to initialize balance payment" });
    }
    return res.json({ reference, paymentUrl: data.data.authorization_url, total: chargeAmount, processingFee });
  } catch (err) {
    console.error("INSTALLMENT PAYMENT ERROR:", err);
    return res.status(500).json({ message: "Could not start balance payment" });
  }
};

export const getOrganizerInstallments = async (req, res) => {
  try {
    const filter = { organizer: req.user._id };
    if (req.query.eventId) filter.event = req.query.eventId;
    const plans = await InstallmentPlan.find(filter)
      .populate("event", "title date")
      .sort("-createdAt")
      .limit(500)
      .lean();
    res.json(plans.map((plan) => ({
      ...plan,
      email: plan.email.replace(/^(.).*(@.*)$/, "$1***$2"),
    })));
  } catch (err) {
    console.error("ORGANIZER INSTALLMENTS ERROR:", err);
    res.status(500).json({ message: "Unable to load installment plans" });
  }
};

export const getAdminInstallments = async (req, res) => {
  try {
    const plans = await InstallmentPlan.find({})
      .populate("event", "title date")
      .populate("organizer", "name email")
      .sort("-createdAt")
      .limit(1000)
      .lean();
    res.json(plans.map((plan) => ({
      ...plan,
      email: plan.email.replace(/^(.).*(@.*)$/, "$1***$2"),
    })));
  } catch (err) {
    console.error("ADMIN INSTALLMENTS ERROR:", err);
    res.status(500).json({ message: "Unable to load installment plans" });
  }
};

export { processInstallmentPayment, emailInstallmentPlanUpdate };
