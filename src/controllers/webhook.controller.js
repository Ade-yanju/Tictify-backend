import crypto from "crypto";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";

/* =====================================================
   ERCASPAY WEBHOOK (DOC-CORRECT)
===================================================== */
export const handlePaymentWebhook = async (req, res) => {
  try {
    /* ================= VERIFY SIGNATURE ================= */
    const signature = req.headers["x-ercaspay-signature"];
    if (!signature) {
      return res.status(400).send("Missing signature");
    }

    // IMPORTANT: req.body MUST be raw buffer
    const rawBody = req.body;

    const expectedSignature = crypto
      .createHmac("sha512", process.env.ERCASPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("❌ Invalid ERCASPAY signature");
      return res.status(401).send("Invalid signature");
    }

    /* ================= PARSE PAYLOAD ================= */
    const payload = JSON.parse(rawBody.toString());

    console.log("ERCASPAY WEBHOOK PAYLOAD:", JSON.stringify(payload, null, 2));

    const status = payload?.status || payload?.responseBody?.status;

    if (status !== "SUCCESSFUL") {
      return res.status(200).json({ received: true });
    }

    const reference =
      payload?.paymentReference ||
      payload?.tx_reference ||
      payload?.responseBody?.tx_reference;

    if (!reference) {
      console.error("❌ Missing payment reference");
      return res.status(200).json({ received: true });
    }

    /* ================= IDEMPOTENCY CHECK ================= */
    const existingPayment = await Payment.findOne({ reference });
    if (existingPayment?.status === "SUCCESS") {
      return res.status(200).json({ received: true });
    }

    /* ================= VERIFY TRANSACTION (SAFETY) ================= */
    const ercasRes = await fetch(
      `https://api.ercaspay.com/api/v1/payment/transaction/verify/${reference}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.ERCASPAY_SECRET_KEY}`,
          Accept: "application/json",
        },
      },
    );

    const ercasData = await ercasRes.json();

    if (
      ercasData?.requestSuccessful !== true ||
      ercasData?.responseBody?.status !== "SUCCESSFUL"
    ) {
      return res.status(200).json({ received: true });
    }

    /* ================= SAVE PAYMENT ================= */
    const metadata = ercasData.responseBody?.metadata || {};
    const { eventId, ticketType, email } = metadata;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(200).json({ received: true });
    }

    const ticketConfig = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticketConfig) {
      return res.status(200).json({ received: true });
    }

    const amount = Number(ticketConfig.price);

    const payment = await Payment.findOneAndUpdate(
      { reference },
      {
        reference,
        status: "SUCCESS",
        amount,
        email,
        event: eventId,
        organizer: event.organizer,
        currency: "NGN",
      },
      { upsert: true, new: true },
    );

    /* ================= CREATE TICKET ================= */
    const existingTicket = await Ticket.findOne({
      paymentRef: reference,
    });

    if (!existingTicket) {
      await Ticket.create({
        event: eventId,
        organizer: event.organizer,
        buyerEmail: email,
        qrCode: crypto.randomBytes(16).toString("hex"),
        scanned: false,
        paymentRef: reference,
        amountPaid: amount,
        ticketType,
        currency: "NGN",
      });
    }

    /* ================= CREDIT WALLET ================= */
// 🔑 Use the original payment record (source of truth)
if (!payment || payment.status !== "SUCCESS") {
  return res.status(200).json({ received: true });
}

// Organizer earns exactly what was defined at initiation
const organizerAmount = payment.organizerAmount;

let wallet = await Wallet.findOne({ organizer: payment.organizer });
if (!wallet) {
  wallet = await Wallet.create({
    organizer: payment.organizer,
    balance: 0,
    totalEarnings: 0,
  });
}

wallet.balance += organizerAmount;
wallet.totalEarnings += organizerAmount;
await wallet.save();

return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
