import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";

/* =====================================================
   ERCASPAY WEBHOOK — PRODUCTION SAFE
===================================================== */
export const handlePaymentWebhook = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    /* ================= VERIFY SIGNATURE ================= */

    const signature = req.headers["x-ercaspay-signature"];

    if (!signature) {
      return res.status(400).send("Missing signature");
    }

    const expectedSignature = crypto
      .createHmac("sha512", process.env.ERCASPAY_WEBHOOK_SECRET)
      .update(req.body) // raw buffer
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("❌ Invalid ERCASPAY signature");
      return res.status(401).send("Invalid signature");
    }

    const payload = JSON.parse(req.body.toString());

    console.log("✅ ERCASPAY WEBHOOK:", payload);

    const status = payload?.status || payload?.responseBody?.status;

    if (status !== "SUCCESSFUL") {
      return res.status(200).send("ignored");
    }

    const reference =
      payload?.paymentReference ||
      payload?.tx_reference ||
      payload?.responseBody?.paymentReference ||
      payload?.responseBody?.tx_reference;

    if (!reference) {
      console.error("❌ Missing reference");
      return res.status(200).send("ignored");
    }

    /* =====================================================
       🔥 START DB TRANSACTION
    ===================================================== */

    await session.withTransaction(async () => {
      const payment = await Payment.findOne({ reference }).session(session);

      if (!payment) {
        console.error("❌ Payment not found:", reference);
        return;
      }

      // 🔐 IDempotency guard (MOST IMPORTANT LINE)
      if (payment.status === "SUCCESS") {
        return;
      }

      /* ================= VERIFY WITH ERCASPAY ================= */

      const verifyRes = await fetch(
        `https://api.ercaspay.com/api/v1/payment/transaction/verify/${reference}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${process.env.ERCASPAY_SECRET_KEY}`,
            Accept: "application/json",
          },
        },
      );

      const verifyData = await verifyRes.json();

      if (
        verifyData?.requestSuccessful !== true ||
        verifyData?.responseBody?.status !== "SUCCESSFUL"
      ) {
        console.error("❌ Verification failed:", reference);
        return;
      }

      /* ================= MARK PAYMENT SUCCESS ================= */

      payment.status = "SUCCESS";
      payment.verifiedAt = new Date();
      payment.gatewayResponse = verifyData;

      await payment.save({ session });

      /* ================= CREATE TICKET ================= */

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
              scanned: false,
              paymentRef: reference,
              amountPaid: payment.organizerAmount,
              ticketType: payment.ticketType,
              currency: "NGN",
            },
          ],
          { session },
        );
      }

      /* ================= CREDIT WALLET ================= */

      let wallet = await Wallet.findOne({
        organizer: payment.organizer,
      }).session(session);

      if (!wallet) {
        wallet = await Wallet.create(
          [
            {
              organizer: payment.organizer,
              balance: 0,
              totalEarnings: 0,
            },
          ],
          { session },
        ).then((res) => res[0]);
      }

      wallet.balance += payment.organizerAmount;
      wallet.totalEarnings += payment.organizerAmount;

      await wallet.save({ session });
    });

    session.endSession();

    return res.status(200).send("processed");
  } catch (error) {
    session.endSession();
    console.error("🚨 WEBHOOK ERROR:", error);
    return res.status(500).send("error");
  }
};
