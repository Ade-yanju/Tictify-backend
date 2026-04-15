import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";

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
            },
          ],
          { session },
        );

        /* ── Update event capacity ── */
        const event = await Event.findById(payment.event).session(session);
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
    return res.status(200).send("processed");
  } catch (error) {
    session.endSession();
    console.error("🚨 WEBHOOK ERROR:", error);
    return res.status(500).send("error");
  }
};
