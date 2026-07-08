import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import { sendEmail } from "../services/email.service.js";

const PUBLIC_API =
  process.env.BACKEND_URL || "https://tictify-backend.onrender.com";

/* ── Post-payment ticket email (non-blocking) ── */
async function emailTicketToGuest(reference) {
  try {
    const ticket = await Ticket.findOne({ paymentRef: reference }).populate("event");
    if (!ticket || !ticket.buyerEmail) return;

    const ev = ticket.event || {};
    const groupNote =
      (ticket.groupSize || 1) > 1
        ? `<p style="margin:4px 0;"><strong>Admits:</strong> ${ticket.groupSize} guests on one QR code</p>`
        : "";

    sendEmail({
      to: ticket.buyerEmail,
      subject: `Your Ticket for ${ev.title || "your event"} is Ready! 🎟️`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;border:1px solid #eee;border-radius:16px;background:#fafafa;">
          <h2 style="color:#1a1a1a;margin-top:0;">Payment confirmed — you're going! ✅</h2>
          <div style="background:#fff;padding:20px;border-radius:12px;margin:20px 0;border-left:4px solid #E8C96A;">
            <p style="margin:4px 0;"><strong>Event:</strong> ${ev.title || "—"}</p>
            <p style="margin:4px 0;"><strong>Date:</strong> ${ev.date ? new Date(ev.date).toDateString() : "—"}</p>
            <p style="margin:4px 0;"><strong>Location:</strong> ${ev.location || "—"}</p>
            <p style="margin:4px 0;"><strong>Ticket:</strong> ${ticket.ticketType || "—"}</p>
            ${groupNote}
            <p style="margin:12px 0 0;font-size:12px;color:#888;"><strong>Reference:</strong> ${reference}</p>
          </div>
          <div style="text-align:center;background:#fff;padding:20px;border-radius:12px;margin:20px 0;">
            <p style="font-size:12px;color:#888;margin:0 0 10px;">Show this QR code at the entrance</p>
            <img src="${PUBLIC_API}/api/tickets/qr/${reference}" alt="Ticket QR" width="200" height="200" style="width:200px;height:200px;display:inline-block;" />
          </div>
          <a href="${process.env.FRONTEND_URL}/success/${reference}"
             style="display:inline-block;background:#E8C96A;color:#000;padding:13px 26px;text-decoration:none;border-radius:50px;font-weight:bold;">
            View My Ticket
          </a>
          <p style="font-size:12px;color:#999;margin-top:26px;">© ${new Date().getFullYear()} Tictify. No printing needed — your phone is your ticket.</p>
        </div>
      `,
    })
      .then((result) => {
        if (result?.success) {
          return Ticket.updateOne(
            { paymentRef: reference },
            { emailedAt: new Date() },
          );
        }
      })
      .catch((err) => console.error("Ticket email failed:", err.message));
  } catch (err) {
    console.error("Ticket email lookup failed:", err.message);
  }
}

/* =====================================================
   PAYSTACK WEBHOOK — PRODUCTION SAFE
===================================================== */
export const handlePaymentWebhook = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    /* ================= VERIFY SIGNATURE ================= */
    const signature = req.headers["x-paystack-signature"];

    if (!signature) {
      return res.status(400).send("Missing signature");
    }

    const expectedSignature = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.body) // raw buffer — must be raw, not parsed
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("❌ Invalid Paystack signature");
      return res.status(401).send("Invalid signature");
    }

    const payload = JSON.parse(req.body.toString());

    // Only handle successful charge events
    if (payload.event !== "charge.success") {
      return res.status(200).send("ignored");
    }

    const reference = payload?.data?.reference;

    if (!reference || !reference.startsWith("TICTIFY-")) {
      console.error("❌ Missing or unrecognised reference");
      return res.status(200).send("ignored");
    }

    console.log("✅ PAYSTACK WEBHOOK:", reference);

    /* =====================================================
       🔥 DB TRANSACTION
    ===================================================== */
    await session.withTransaction(async () => {
      /* ── Find payment ── */
      let payment = await Payment.findOne({ reference }).session(session);

      if (!payment) {
        // Recover from webhook metadata if payment record is missing
        console.warn("⚠️ Payment not found, recovering from webhook payload");
        const meta = payload.data.metadata;
        const fallbackEvent = await Event.findById(meta?.eventId).session(
          session,
        );

        payment = await Payment.create(
          [
            {
              reference,
              event: meta?.eventId,
              organizer: fallbackEvent?.organizer ?? null,
              ticketType: meta?.ticketType,
              email: payload.data.customer.email,
              amount: payload.data.amount / 100,
              platformFee: 0,
              organizerAmount: payload.data.amount / 100,
              status: "PENDING",
              provider: "PAYSTACK",
            },
          ],
          { session },
        ).then((r) => r[0]);
      }

      /* ── Idempotency guard ── */
      if (payment.status === "SUCCESS") {
        console.log("ℹ️ Already processed:", reference);
        return;
      }

      /* ── Mark payment success ── */
      payment.status = "SUCCESS";
      payment.verifiedAt = new Date();
      await payment.save({ session });

      /* ── Create ticket if not already exists ── */
      const existingTicket = await Ticket.findOne({
        paymentRef: reference,
      }).session(session);

      if (!existingTicket) {
        const qrCode = crypto.randomBytes(16).toString("hex");
        const qrImage = await QRCode.toDataURL(qrCode);

        /* ── Group tickets: copy admits-per-ticket from the event tier ── */
        const eventDoc = await Event.findById(payment.event).session(session);
        const tierConfig = eventDoc?.ticketTypes.find(
          (t) => t.name === payment.ticketType,
        );
        const groupSize = Math.max(1, tierConfig?.groupSize || 1);

        await Ticket.create(
          [
            {
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
              groupSize,
              admittedCount: 0,
            },
          ],
          { session },
        );

        /* ── Update event capacity ── */
        const event = eventDoc;
        if (event) {
          const ticketConfig = tierConfig;
          if (ticketConfig) ticketConfig.sold += 1;

          const totalSold = event.ticketTypes.reduce(
            (sum, t) => sum + (t.sold || 0),
            0,
          );
          if (totalSold >= event.capacity) event.status = "ENDED";

          await event.save({ session });
        }

        /* ── Credit wallet ── */
        let wallet = await Wallet.findOne({
          organizer: payment.organizer,
        }).session(session);

        if (!wallet) {
          wallet = await Wallet.create(
            [{ organizer: payment.organizer, balance: 0, totalEarnings: 0 }],
            { session },
          ).then((r) => r[0]);
        }

        wallet.balance += payment.organizerAmount;
        wallet.totalEarnings += payment.organizerAmount;
        await wallet.save({ session });

        console.log(`✅ Ticket + wallet credited via webhook: ${reference}`);
      }
    });

    session.endSession();

    // 📧 deliver the ticket to the guest's inbox (fire-and-forget)
    emailTicketToGuest(reference);

    return res.status(200).send("processed");
  } catch (error) {
    session.endSession();
    console.error("🚨 WEBHOOK ERROR:", error);
    return res.status(500).send("error");
  }
};
