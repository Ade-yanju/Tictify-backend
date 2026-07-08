import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import Event from "../models/Event.js";
import QRCode from "qrcode";
import { sendEmail } from "../services/email.service.js";

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
    const ticket = await Ticket.create({
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

    // 📧 SEND TICKET CONFIRMATION EMAIL (async, don't block)
    try {
      const event = await Event.findById(payment.event);
      const eventName = event?.name || "Your Event";
      const eventDate = event?.date
        ? new Date(event.date).toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })
        : "TBD";

      sendEmail({
        to: payment.email,
        subject: `Your Ticket for ${eventName} is Ready! 🎟️`,
        html: `
          <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 32px;">
            <h1 style="color: #22F2A6; margin-bottom: 8px;">Ticket Confirmed! ✅</h1>
            <p style="color: #666; margin-bottom: 20px;">Your payment was successful.</p>

            <div style="background: white; padding: 24px; border-radius: 12px; margin: 24px 0; border-left: 4px solid #22F2A6;">
              <h3 style="color: #1a1a1a; margin-top: 0;">${eventName}</h3>
              <p style="color: #666; margin: 8px 0;">
                <strong>Date:</strong> ${eventDate}<br>
                <strong>Ticket Type:</strong> ${payment.ticketType}<br>
                <strong>Amount Paid:</strong> ₦${payment.amount.toLocaleString()}
              </p>
              <p style="color: #999; font-size: 12px; margin: 16px 0 0 0;">
                <strong>Ref:</strong> ${payment.reference}
              </p>
            </div>

            <div style="background: #f5f5f5; padding: 20px; border-radius: 12px; text-align: center; margin: 24px 0;">
              <p style="color: #666; margin: 0 0 12px 0; font-size: 12px;">Your QR Code:</p>
              <img src="${ticket.qrCode}" alt="Ticket QR" style="width: 200px; height: 200px;" />
            </div>

            <p style="color: #999; font-size: 12px;">
              Present this QR code at the entrance. No printing needed!
            </p>

            <a href="${process.env.FRONTEND_URL}/events" style="display: inline-block; background: #22F2A6; color: #0F0618; padding: 12px 24px; border-radius: 999px; text-decoration: none; font-weight: 600; margin: 24px 0;">
              View Event Details
            </a>

            <p style="color: #999; font-size: 12px; margin-top: 32px;">
              © ${new Date().getFullYear()} Tictify. All rights reserved.
            </p>
          </div>
        `,
      }).catch(err => console.error("Ticket email failed:", err.message));
    } catch (emailErr) {
      console.error("Email sending error:", emailErr.message);
    }

    return res.redirect(`${process.env.FRONTEND_URL}/ticket/success`);
  } catch (err) {
    console.error("PAYMENT SUCCESS ERROR:", err);
    return res.redirect(`${process.env.FRONTEND_URL}/error`);
  }
};
