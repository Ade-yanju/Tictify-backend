import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import QRCode from "qrcode";
import crypto from "crypto";

export const paymentSuccess = async (req, res) => {
  try {
    const { ref } = req.query;

    const payment = await Payment.findOne({ reference: ref });
    if (!payment || payment.status === "SUCCESS") {
      return res.redirect(`${process.env.FRONTEND_URL}/error`);
    }

    payment.status = "SUCCESS";
    await payment.save();

    // Generate QR
    const qrCode = await QRCode.toDataURL(
      `TICKET:${payment.reference}:${payment.email}`,
    );

    // Create Ticket
    await Ticket.create({
      event: payment.event,
      organizer: payment.organizer,
      buyerEmail: payment.email,
      ticketType: payment.ticketType,
      amountPaid: payment.amount,
      paymentRef: payment.reference,
      qrCode,
    });

    // Update Wallet
    const wallet = await Wallet.findOneAndUpdate(
      { organizer: payment.organizer },
      {
        $inc: {
          balance: payment.organizerAmount,
          totalEarnings: payment.organizerAmount,
        },
      },
      { upsert: true, new: true },
    );

    return res.redirect(`${process.env.FRONTEND_URL}/ticket/success`);
  } catch (err) {
    console.error("PAYMENT SUCCESS ERROR:", err);
    return res.redirect(`${process.env.FRONTEND_URL}/error`);
  }
};
