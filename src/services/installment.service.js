import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import InstallmentPlan from "../models/InstallmentPlan.js";
import { sendEmail } from "./email.service.js";
import { sendText, whatsappConfigured } from "./whatsapp.service.js";

const FRONTEND = process.env.FRONTEND_URL || "https://tictify.vercel.app";

export function hashInstallmentToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function createInstallmentToken() {
  return crypto.randomBytes(32).toString("hex");
}

/* A reservation is claimed atomically. The event-level counter protects
   capacity while the filtered tier expression protects a ticket tier. */
export async function reserveInstallmentTickets(eventId, ticketType, quantity) {
  const qty = Number(quantity);
  const soldTotal = {
    $sum: {
      $map: {
        input: { $ifNull: ["$ticketTypes", []] },
        as: "tier",
        in: { $ifNull: ["$$tier.sold", 0] },
      },
    },
  };
  const tierHasRoom = {
    $size: {
      $filter: {
        input: { $ifNull: ["$ticketTypes", []] },
        as: "tier",
        cond: {
          $and: [
            { $eq: ["$$tier.name", ticketType] },
            {
              $gte: [
                {
                  $subtract: [
                    {
                      $subtract: [
                        { $ifNull: ["$$tier.quantity", 0] },
                        { $ifNull: ["$$tier.sold", 0] },
                      ],
                    },
                    { $ifNull: ["$$tier.reserved", 0] },
                  ],
                },
                qty,
              ],
            },
          ],
        },
      },
    },
  };

  return Event.findOneAndUpdate(
    {
      _id: eventId,
      status: "LIVE",
      "ticketTypes.name": ticketType,
      $expr: {
        $and: [
          {
            $gte: [
              {
                $subtract: [
                  { $subtract: ["$capacity", soldTotal] },
                  { $ifNull: ["$reservedTickets", 0] },
                ],
              },
              qty,
            ],
          },
          { $gte: [tierHasRoom, 1] },
        ],
      },
    },
    {
      $inc: {
        reservedTickets: qty,
        "ticketTypes.$.reserved": qty,
      },
    },
    { new: true },
  );
}

export async function releasePlanReservation(plan, session) {
  const eventQuery = Event.findById(plan.event);
  const event = await (session ? eventQuery.session(session) : eventQuery);
  if (!event) return;

  const tier = event.ticketTypes.find((item) => item.name === plan.ticketType);
  if (tier) tier.reserved = Math.max(0, Number(tier.reserved || 0) - plan.quantity);
  event.reservedTickets = Math.max(0, Number(event.reservedTickets || 0) - plan.quantity);
  await event.save({ session });
}

function queryWithSession(query, session) {
  return session ? query.session(session) : query;
}

/* Called from both the webhook and the browser callback. The caller owns
   the surrounding transaction when one is available. */
export async function processInstallmentPayment(payment, session) {
  const plan = await queryWithSession(
    InstallmentPlan.findById(payment.installmentPlan).select("+accessToken"),
    session,
  );
  if (!plan) {
    payment.status = "SUCCESS";
    payment.verifiedAt = new Date();
    await payment.save(session ? { session } : undefined);
    return { completed: false, missingPlan: true };
  }

  /* Paystack can deliver the same success through webhook and callback. */
  if (payment.status === "SUCCESS" || payment.status === "REFUNDED") {
    return { completed: plan.status === "PAID", plan, alreadyProcessed: true };
  }

  payment.status = "SUCCESS";
  payment.verifiedAt = new Date();
  payment.countsAsTicketSale = false;

  const contribution = Math.max(0, Number(payment.installmentAmount || 0));
  if (plan.status === "EXPIRED" || plan.status === "CANCELLED" || plan.status === "REFUNDED") {
    /* A late Paystack success can arrive after the expiry worker released
       the reservation. It is still a real charge, so put the plan back in
       the refund queue instead of silently keeping the money. */
    if (plan.status === "EXPIRED" || plan.status === "REFUNDED") {
      plan.refundStatus = "PENDING";
      plan.refundError = undefined;
      await plan.save(session ? { session } : undefined);
    }
    await payment.save(session ? { session } : undefined);
    return { completed: false, expired: true, plan };
  }

  const paid = Math.min(plan.principalDue, Number(plan.amountPaid || 0) + contribution);
  plan.amountPaid = paid;
  plan.amountRemaining = Math.max(0, plan.principalDue - paid);
  plan.paymentCount = Number(plan.paymentCount || 0) + 1;
  plan.lastPaymentAt = new Date();
  plan.lastPaymentReference = payment.reference;

  if (plan.amountRemaining > 0) {
    plan.status = "PARTIALLY_PAID";
    await payment.save(session ? { session } : undefined);
    await plan.save(session ? { session } : undefined);
    return { completed: false, plan };
  }

  plan.amountPaid = plan.principalDue;
  plan.amountRemaining = 0;
  plan.status = "PAID";
  plan.completedAt = new Date();
  payment.countsAsTicketSale = true;
  payment.organizerAmount = plan.ticketSubtotal;

  const existingTicket = await queryWithSession(
    Ticket.findOne({ paymentRef: plan.reference }),
    session,
  );

  if (!existingTicket) {
    const qrCode = crypto.randomBytes(16).toString("hex");
    const qrImage = await QRCode.toDataURL(qrCode);
    await Ticket.create(
      [
        {
          event: plan.event,
          organizer: plan.organizer,
          buyerEmail: plan.email,
          guestName: plan.name,
          qrCode,
          qrImage,
          ticketType: plan.ticketType,
          paymentRef: plan.reference,
          amountPaid: plan.ticketSubtotal,
          currency: "NGN",
          scanned: false,
          groupSize: plan.quantity * Math.max(1, plan.groupSize || 1),
          admittedCount: 0,
        },
      ],
      session ? { session } : undefined,
    );

    const event = await queryWithSession(Event.findById(plan.event), session);
    if (event) {
      const tier = event.ticketTypes.find((item) => item.name === plan.ticketType);
      if (tier) {
        tier.reserved = Math.max(0, Number(tier.reserved || 0) - plan.quantity);
        tier.sold = Number(tier.sold || 0) + plan.quantity;
      }
      event.reservedTickets = Math.max(0, Number(event.reservedTickets || 0) - plan.quantity);
      const totalSold = event.ticketTypes.reduce((sum, item) => sum + Number(item.sold || 0), 0);
      if (totalSold >= event.capacity) event.status = "ENDED";
      await event.save(session ? { session } : undefined);
    }

    let wallet = await queryWithSession(
      Wallet.findOne({ organizer: plan.organizer }),
      session,
    );
    if (!wallet) {
      wallet = await Wallet.create(
        [{ organizer: plan.organizer, balance: 0, totalEarnings: 0 }],
        session ? { session } : undefined,
      ).then((rows) => rows[0]);
    }
    wallet.balance += plan.ticketSubtotal;
    wallet.totalEarnings += plan.ticketSubtotal;
    await wallet.save(session ? { session } : undefined);
  }

  await payment.save(session ? { session } : undefined);
  await plan.save(session ? { session } : undefined);
  /* Commission is paid once, at completion, because the organizer does
     not receive any wallet funds until the reservation becomes a ticket. */
  import("./commission.service.js")
    .then(({ creditAmbassadorCommission }) =>
      creditAmbassadorCommission({
        ...payment.toObject(),
        platformFee: plan.platformFee,
        promoter: plan.promoter,
        organizerAmount: plan.ticketSubtotal,
      }),
    )
    .catch(() => {});
  return { completed: true, plan };
}

export async function expireInstallmentPlans() {
  const candidates = await InstallmentPlan.find({
    status: { $in: ["RESERVED", "PARTIALLY_PAID"] },
    dueAt: { $lte: new Date() },
  }).limit(200);
  let expired = 0;

  for (const candidate of candidates) {
    const session = await mongoose.startSession();
    try {
      let claimed = false;
      await session.withTransaction(async () => {
        const plan = await InstallmentPlan.findOne({
          _id: candidate._id,
          status: { $in: ["RESERVED", "PARTIALLY_PAID"] },
          dueAt: { $lte: new Date() },
        }).session(session);
        if (!plan) return;
        plan.status = "EXPIRED";
        plan.expiredAt = new Date();
        plan.reservationReleasedAt = new Date();
        plan.refundStatus = Number(plan.amountPaid || 0) > 0
          ? "PENDING"
          : "NOT_REQUIRED";
        plan.refundError = undefined;
        await releasePlanReservation(plan, session);
        await plan.save({ session });
        claimed = true;
      });
      if (claimed) expired += 1;
    } catch (err) {
      console.error("INSTALLMENT EXPIRY ERROR:", err.message);
    } finally {
      await session.endSession();
    }
  }
  const refunds = await processPendingInstallmentRefunds();
  return { expired, ...refunds };
}

async function emailInstallmentRefund(plan) {
  if (!plan || plan.refundEmailSentAt) return;
  const result = await sendEmail({
    to: plan.email,
    subject: `Your installment refund for ${plan.eventTitle || "your event"}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#fafafa;border-radius:16px;">
        <h2 style="color:#1a1a1a;">Your installment reservation was refunded</h2>
        <p>Your reservation for <strong>${plan.eventTitle || "your event"}</strong> expired before the balance was completed.</p>
        <p>We have issued a full refund of <strong>₦${Number(plan.refundedAmount || 0).toLocaleString()}</strong> to the original payment method, including payment-processing fees.</p>
        <p>Your bank or card provider may take 3–10 working days to display the refund.</p>
        <p style="font-size:12px;color:#888;margin-top:26px;">Reference: ${plan.reference}</p>
      </div>
    `,
  });
  if (result?.success) {
    await InstallmentPlan.updateOne(
      { _id: plan._id, refundStatus: "COMPLETED" },
      { $set: { refundEmailSentAt: new Date() } },
    );
  }
  if (plan.waPhone && whatsappConfigured) {
    sendText(
      plan.waPhone,
      `↩️ Your installment reservation for *${plan.eventTitle || "your event"}* expired before completion.\n\n` +
        `A full refund of ${Number(plan.refundedAmount || 0).toLocaleString("en-NG")} has been issued to the original payment method. ` +
        `Your bank or card provider may take a few working days to display it.`,
    ).catch((err) => console.error("Installment WhatsApp refund failed:", err.message));
  }
}

/* Refund every successful installment charge, including Paystack's
   processing fee, to the original payment method. A short lease prevents
   an in-process sweep and an external cron call from refunding the same
   plan at the same time. */
export async function refundExpiredInstallmentPlan(planId) {
  const leaseCutoff = new Date(Date.now() - 10 * 60 * 1000);
  const plan = await InstallmentPlan.findOneAndUpdate(
    {
      _id: planId,
      status: { $in: ["EXPIRED", "REFUNDED"] },
      refundStatus: { $in: ["PENDING", "PARTIAL"] },
      $or: [
        { refundStartedAt: { $exists: false } },
        { refundStartedAt: { $lte: leaseCutoff } },
      ],
    },
    {
      $set: { refundStartedAt: new Date() },
      $inc: { refundAttempts: 1 },
    },
    { new: true },
  );
  if (!plan) return { refunded: 0, skipped: true };

  const payments = await Payment.find({
    installmentPlan: plan._id,
    status: "SUCCESS",
  });
  if (payments.length === 0) {
    plan.refundStatus = "NOT_REQUIRED";
    plan.refundStartedAt = undefined;
    await plan.save();
    return { refunded: 0 };
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  const errors = [];
  let refundedAmount = 0;
  let refunded = 0;
  for (const payment of payments) {
    if (payment.provider !== "PAYSTACK") {
      errors.push(`${payment.reference}: unsupported refund provider`);
      continue;
    }
    if (!secret) {
      errors.push(`${payment.reference}: PAYSTACK_SECRET_KEY is not configured`);
      continue;
    }
    try {
      const response = await fetch("https://api.paystack.co/refund", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transaction: payment.reference }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.status) {
        throw new Error(data.message || `Paystack returned ${response.status}`);
      }
      await Payment.updateOne(
        { _id: payment._id, status: "SUCCESS" },
        {
          $set: {
            status: "REFUNDED",
            gatewayResponse: {
              ...(payment.gatewayResponse || {}),
              refund: data.data,
              refundedAt: new Date(),
            },
          },
        },
      );
      refunded += 1;
      refundedAmount += Math.max(0, Number(payment.amount || 0));
    } catch (err) {
      errors.push(`${payment.reference}: ${err.message}`);
    }
  }

  const remaining = await Payment.countDocuments({
    installmentPlan: plan._id,
    status: "SUCCESS",
  });
  plan.refundedAmount = Math.round(
    Number(plan.refundedAmount || 0) + refundedAmount,
  );
  plan.refundStartedAt = undefined;
  plan.refundError = errors.length ? errors.join("; ").slice(0, 1000) : undefined;
  if (remaining === 0) {
    plan.refundStatus = "COMPLETED";
    plan.status = "REFUNDED";
    plan.refundedAt = new Date();
    await plan.save();
    await emailInstallmentRefund(plan);
  } else {
    plan.refundStatus = refunded > 0 ? "PARTIAL" : "PENDING";
    await plan.save();
  }
  return { refunded, remaining };
}

export async function processPendingInstallmentRefunds() {
  const plans = await InstallmentPlan.find({
    status: { $in: ["EXPIRED", "REFUNDED"] },
    refundStatus: { $in: ["PENDING", "PARTIAL"] },
  })
    .limit(100)
    .select("_id");
  let refunded = 0;
  for (const plan of plans) {
    const result = await refundExpiredInstallmentPlan(plan._id);
    refunded += result.refunded || 0;
  }
  return { refunded };
}

export async function emailInstallmentPlanUpdate(reference) {
  try {
    const plan = await InstallmentPlan.findOne({ reference })
      .select("+accessToken")
      .populate("event", "title date location");
    if (!plan || plan.status === "PAID") return;

    const url = `${FRONTEND}/installments/${plan.accessToken}`;
    const event = plan.event || {};
    await sendEmail({
      to: plan.email,
      subject: `Your installment reservation for ${event.title || plan.eventTitle}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#fafafa;border-radius:16px;">
          <h2 style="color:#1a1a1a;">Your ticket reservation is secured ✅</h2>
          <p>You have paid <strong>₦${Number(plan.amountPaid).toLocaleString()}</strong> toward your ${plan.ticketType} ticket for <strong>${event.title || plan.eventTitle}</strong>.</p>
          <p><strong>Remaining balance:</strong> ₦${Number(plan.amountRemaining).toLocaleString()}</p>
          <p><strong>Complete payment by:</strong> ${new Date(plan.dueAt).toLocaleString("en-NG")}</p>
          <p>Your QR ticket will be issued automatically after the remaining balance is paid.</p>
          <a href="${url}" style="display:inline-block;background:#E8C96A;color:#000;padding:13px 26px;text-decoration:none;border-radius:50px;font-weight:bold;">View reservation &amp; pay balance</a>
          <p style="font-size:12px;color:#888;margin-top:26px;">Reference: ${plan.reference}</p>
        </div>
      `,
    });
  } catch (err) {
    console.error("INSTALLMENT EMAIL ERROR:", err.message);
  }
}

function installmentPlanUrl(plan) {
  return `${FRONTEND}/installments/${plan.accessToken}`;
}

function reminderHtml(plan, urgency) {
  const eventTitle = plan.event?.title || plan.eventTitle || "your event";
  const dueAt = new Date(plan.dueAt).toLocaleString("en-NG");
  const message = urgency === "due-soon"
    ? "Your installment balance is due soon. Complete it now to keep your reservation active."
    : "This is a reminder that your installment balance is due tomorrow.";

  return `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#fafafa;border-radius:16px;">
      <h2 style="color:#1a1a1a;">Complete your ticket payment</h2>
      <p>${message}</p>
      <p><strong>Event:</strong> ${eventTitle}</p>
      <p><strong>Remaining balance:</strong> ₦${Number(plan.amountRemaining).toLocaleString()}</p>
      <p><strong>Payment deadline:</strong> ${dueAt}</p>
      <p>Your QR ticket is issued automatically after the remaining balance is paid.</p>
      <a href="${installmentPlanUrl(plan)}" style="display:inline-block;background:#E8C96A;color:#000;padding:13px 26px;text-decoration:none;border-radius:50px;font-weight:bold;">Pay balance</a>
      <p style="font-size:12px;color:#888;margin-top:26px;">Reference: ${plan.reference}</p>
    </div>
  `;
}

async function sendInstallmentReminder(plan, urgency) {
  return sendEmail({
    to: plan.email,
    subject: urgency === "due-soon"
      ? `Your ${plan.event?.title || plan.eventTitle} balance is due soon`
      : `Reminder: complete your ${plan.event?.title || plan.eventTitle} ticket payment`,
    html: reminderHtml(plan, urgency),
  });
}

/* Send each active guest at most one 24-hour reminder and one final
   near-deadline reminder. The timestamp is claimed before sending so two
   cron workers cannot send duplicates; failed sends are released for retry. */
export async function sendInstallmentReminders() {
  const now = new Date();
  const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  let sent = 0;

  const jobs = [
    {
      field: "reminder24hSentAt",
      filter: { dueAt: { $gt: inTwoHours, $lte: in24Hours } },
      urgency: "tomorrow",
    },
    {
      field: "reminderDueSentAt",
      filter: { dueAt: { $gt: now, $lte: inTwoHours } },
      urgency: "due-soon",
    },
  ];

  for (const job of jobs) {
    const candidates = await InstallmentPlan.find({
      status: { $in: ["RESERVED", "PARTIALLY_PAID"] },
      amountRemaining: { $gt: 0 },
      ...job.filter,
      [job.field]: { $exists: false },
    })
      .select("+accessToken")
      .populate("event", "title")
      .limit(200)
      .lean();

    for (const candidate of candidates) {
      const claimed = await InstallmentPlan.findOneAndUpdate(
        {
          _id: candidate._id,
          status: { $in: ["RESERVED", "PARTIALLY_PAID"] },
          amountRemaining: { $gt: 0 },
          [job.field]: { $exists: false },
        },
        { $set: { [job.field]: new Date() } },
        { new: true },
      )
        .select("+accessToken")
        .populate("event", "title")
        .lean();

      if (!claimed) continue;
      const result = await sendInstallmentReminder(claimed, job.urgency);
      if (result?.success) {
        sent += 1;
      } else {
        await InstallmentPlan.updateOne(
          { _id: claimed._id, [job.field]: { $exists: true } },
          { $unset: { [job.field]: 1 } },
        ).catch(() => {});
      }
    }
  }

  return { sent };
}
