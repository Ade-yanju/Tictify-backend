import crypto from "crypto";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";
import { generateQRCode } from "../utils/qr.js";

export const handlePaymentWebhook = async (req, res) => {
  try {
    /* ================= VERIFY SIGNATURE ================= */
    const signature = req.headers["x-ercaspay-signature"];

    if (!signature) {
      return res.status(400).send("Missing signature");
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.ERCASPAY_WEBHOOK_SECRET)
      .update(req.body) // ⚠️ RAW BODY BUFFER
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("❌ Invalid ERCASPAY signature");
      return res.status(401).send("Invalid signature");
    }

    /* ================= PARSE PAYLOAD ================= */
    const payload = JSON.parse(req.body.toString());

    if (payload.status !== "SUCCESS") {
      return res.status(200).json({ received: true });
    }

    const { reference, metadata } = payload;
    const { eventId, email, ticketType } = metadata;

    /* ================= IDEMPOTENCY CHECK ================= */
    const existingPayment = await Payment.findOne({ reference });
    if (existingPayment?.status === "SUCCESS") {
      return res.status(200).json({ received: true });
    }

    /* ================= VALIDATE EVENT ================= */
    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE") {
      return res.status(400).json({ message: "Invalid event" });
    }

    const ticketConfig = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticketConfig) {
      return res.status(400).json({ message: "Invalid ticket type" });
    }

    const amount = Number(ticketConfig.price);

    /* ================= SAVE PAYMENT ================= */
    await Payment.findOneAndUpdate(
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
    const ticketCode = crypto.randomBytes(16).toString("hex");
    const qrImage = await generateQRCode(ticketCode);

    await Ticket.create({
      event: eventId,
      organizer: event.organizer,
      buyerEmail: email,
      qrCode: ticketCode,
      scanned: false,
      paymentRef: reference,
      amountPaid: amount,
      ticketType,
      currency: "NGN",
    });

    /* ================= CREDIT WALLET ================= */
    const platformFee = Math.round(amount * 0.03 + 80);
    const organizerAmount = amount - platformFee;

    let wallet = await Wallet.findOne({ organizer: event.organizer });
    if (!wallet) {
      wallet = await Wallet.create({
        organizer: event.organizer,
        balance: 0,
        totalEarnings: 0,
      });
    }

    wallet.balance += organizerAmount;
    wallet.totalEarnings += organizerAmount;
    await wallet.save();

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return res.status(500).send("Webhook error");
  }
};
