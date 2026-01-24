import crypto from "crypto";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";
import { generateQRCode } from "../utils/qr.js";
//import { sendTicketEmail } from "../utils/email.js";

export const handlePaymentWebhook = async (req, res) => {
  try {
    const payload = req.body;

    /**
     * 1️⃣ VERIFY PAYMENT STATUS
     */
    if (payload.status !== "SUCCESS") {
      return res.status(200).json({ received: true });
    }

    const { eventId, email, ticketType } = payload.metadata;

    /**
     * 2️⃣ VALIDATE EVENT
     */
    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE") {
      return res.status(400).json({ message: "Invalid event" });
    }

    /**
     * 3️⃣ GENERATE UNIQUE TICKET CODE
     */
    const ticketCode = crypto.randomBytes(16).toString("hex");

    /**
     * 4️⃣ GENERATE QR CODE
     */
    const qrCode = await generateQRCode(ticketCode);

    /**
     * 5️⃣ CREATE TICKET
     */
    const ticket = await Ticket.create({
      event: event._id,
      buyerEmail: email,
      qrCode,
    });

    /**
     * 6️⃣ EMAIL QR CODE
     */
    await sendTicketEmail({
      to: email,
      eventTitle: event.title,
      qrCode,
      ticketType,
      date: event.date,
      location: event.location,
    });

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return res.status(500).json({ received: false });
  }
};
