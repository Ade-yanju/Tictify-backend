// import Event from "../models/Event.js";
// import crypto from "crypto";
// import fetch from "node-fetch";

// export const initiatePayment = async (req, res) => {
//   try {
//     const { eventId, ticketType, email } = req.body;

//     if (!eventId || !ticketType || !email) {
//       return res.status(400).json({ message: "Invalid payment request" });
//     }

//     const event = await Event.findById(eventId);
//     if (!event) {
//       return res.status(404).json({ message: "Event not found" });
//     }

//     const ticket = event.ticketTypes.find((t) => t.name === ticketType);

//     if (!ticket) {
//       return res.status(400).json({ message: "Invalid ticket type" });
//     }

//     const amount = ticket.price;

//     // FREE EVENT
//     if (amount === 0) {
//       return res.json({
//         paymentUrl: `/success?event=${eventId}&ticket=${ticketType}&email=${email}`,
//       });
//     }

//     const reference = `EVT-${crypto.randomBytes(8).toString("hex")}`;

//     const payload = {
//       amount,
//       reference,
//       currency: "NGN",
//       customerEmail: email,
//       redirectUrl: `${process.env.FRONTEND_URL}/payment/callback`,
//       paymentMethods: ["card", "transfer"],
//       description: `Ticket purchase for ${event.title}`,
//     };

//     const ercasRes = await fetch(
//       "https://api.ercaspay.com/api/v1/payment/initiate",
//       {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `Bearer ${process.env.ERCASPAY_SECRET_KEY}`,
//         },
//         body: JSON.stringify(payload),
//       },
//     );

//     const raw = await ercasRes.text();

//     let data;
//     try {
//       data = JSON.parse(raw);
//     } catch {
//       console.error("ERCASPAY RAW RESPONSE:", raw);
//       return res.status(500).json({
//         message: "Invalid response from payment gateway",
//       });
//     }

//     if (!ercasRes.ok || !data?.data?.checkoutUrl) {
//       console.error("ERCASPAY ERROR:", data);
//       return res.status(500).json({
//         message: "Payment gateway error",
//       });
//     }

//     res.json({
//       paymentUrl: data.data.checkoutUrl,
//     });
//   } catch (err) {
//     console.error("PAYMENT INIT ERROR:", err);
//     res.status(500).json({ message: "Payment initiation failed" });
//   }
// };
// import crypto from "crypto";
// import QRCode from "qrcode";

// import Event from "../models/Event.js";
// import Payment from "../models/Payment.js";
// import Ticket from "../models/Ticket.js";
// import Wallet from "../models/Wallet.js";
// //import { sendTicketEmail } from "../utils/sendTicketEmail.js";

// export const initiatePayment = async (req, res) => {
//   try {
//     const { eventId, ticketType, email } = req.body;

//     /* ================= VALIDATION ================= */
//     if (!eventId || !ticketType || !email) {
//       return res.status(400).json({ message: "Invalid payment request" });
//     }

//     const event = await Event.findById(eventId);
//     if (!event) {
//       return res.status(404).json({ message: "Event not found" });
//     }

//     const ticket = event.ticketTypes.find((t) => t.name === ticketType);
//     if (!ticket) {
//       return res.status(400).json({ message: "Invalid ticket type" });
//     }

//     const amount = Number(ticket.price);

//     /* ================= REFERENCES ================= */
//     const reference = `MOCK-${crypto.randomBytes(8).toString("hex")}`;
//     const qrToken = `TICKET-${crypto.randomBytes(12).toString("hex")}`;

//     /* ================= GENERATE QR IMAGE ================= */
//     const qrPayload = JSON.stringify({
//       eventId,
//       ticketType,
//       email,
//       ref: reference,
//       token: qrToken,
//     });

//     const qrImage = await QRCode.toDataURL(qrPayload);

//     /* ================= PLATFORM FEE ================= */
//     const platformFee = Math.round(amount * 0.03 + 80);
//     const organizerAmount = Math.max(amount - platformFee, 0);

//     /* ================= CREATE PAYMENT ================= */
//     await Payment.create({
//       event: eventId,
//       organizer: event.organizer,
//       ticketType: ticket.name,
//       email,
//       amount,
//       reference,
//       status: "SUCCESS",
//     });

//     /* ================= CREATE TICKET ================= */
//     await Ticket.create({
//       event: eventId,
//       organizer: event.organizer,
//       buyerEmail: email,
//       qrCode: qrToken, // store token, not image
//       scanned: false,
//       paymentRef: reference,
//       amountPaid: amount,
//       ticketType: ticket.name,
//       currency: "NGN",
//     });

//     /* ================= WALLET CREDIT ================= */
//     let wallet = await Wallet.findOne({ organizer: event.organizer });

//     if (!wallet) {
//       wallet = await Wallet.create({
//         organizer: event.organizer,
//         balance: 0,
//         totalEarnings: 0,
//       });
//     }

//     wallet.balance += organizerAmount;
//     wallet.totalEarnings += organizerAmount;
//     await wallet.save();

//     /* ================= SEND EMAIL (RESEND) ================= */
//     try {
//       await sendTicketEmail({
//         to: email,
//         eventTitle: event.title,
//         qrImage, // base64 image for Resend
//         ticketType: ticket.name,
//         date: event.date,
//         location: event.location,
//       });
//     } catch (emailError) {
//       // IMPORTANT: email failure must NOT break payment
//       console.error("❌ Ticket email failed:", emailError);
//     }

//     /* ================= RESPONSE ================= */
//     return res.json({
//       paymentUrl: `/success?ref=${reference}`,
//     });
//   } catch (error) {
//     console.error("PAYMENT INIT ERROR:", error);
//     return res.status(500).json({ message: "Payment failed" });
//   }
// };
import crypto from "crypto";
import QRCode from "qrcode";

import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";

export const initiatePayment = async (req, res) => {
  try {
    const { eventId, ticketType, email } = req.body;

    /* ================= VALIDATION ================= */
    if (!eventId || !ticketType || !email) {
      return res.status(400).json({ message: "Invalid payment request" });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    const ticket = event.ticketTypes.find((t) => t.name === ticketType);
    if (!ticket) {
      return res.status(400).json({ message: "Invalid ticket type" });
    }

    const amount = Number(ticket.price);

    /* ================= REFERENCES ================= */
    const reference = `MOCK-${crypto.randomBytes(8).toString("hex")}`;
    const qrToken = `TICKET-${crypto.randomBytes(12).toString("hex")}`;

    /* ================= GENERATE QR ================= */
    const qrImage = await QRCode.toDataURL(qrToken);

    /* ================= PLATFORM FEE ================= */
    const platformFee = Math.round(amount * 0.03 + 80);
    const organizerAmount = amount - platformFee;

    /* ================= PAYMENT ================= */
    await Payment.create({
      event: eventId,
      organizer: event.organizer,
      ticketType: ticket.name,
      email,
      amount,
      reference,
      status: "SUCCESS",
    });

    /* ================= TICKET ================= */
    await Ticket.create({
      event: eventId,
      organizer: event.organizer,
      buyerEmail: email,
      qrCode: qrToken,
      scanned: false,
      paymentRef: reference,
      amountPaid: amount,
      ticketType: ticket.name,
      currency: "NGN",
    });

    /* ================= WALLET ================= */
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

    /* ================= SUCCESS ================= */
    return res.json({
      paymentUrl: `${process.env.FRONTEND_URL}/success?ref=${reference}`,
    });
  } catch (error) {
    console.error("PAYMENT INIT ERROR:", error);
    return res.status(500).json({ message: "Payment failed" });
  }
};
