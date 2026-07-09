import crypto from "crypto";
import Payment from "../models/Payment.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import Event from "../models/Event.js";
import QRCode from "qrcode";
import { sendEmail } from "../services/email.service.js";

const PUBLIC_API =
  process.env.BACKEND_URL || "https://tictify-backend.onrender.com";

export const paymentSuccess = async (req, res) => {
  try {
    const { ref } = req.query;

    const payment = await Payment.findOne({ reference: ref });
    if (!payment || payment.status === "SUCCESS") {
      return res.redirect(`${process.env.FRONTEND_URL}/error`);
    }

    payment.status = "SUCCESS";
    await payment.save();

    /* Idempotency — never mint a second ticket for the same reference */
    const existing = await Ticket.findOne({ paymentRef: payment.reference });
    if (existing) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/success/${payment.reference}`,
      );
    }

    /* Unified QR format: qrCode is the scannable secret (hex),
       qrImage is the picture guests show at the gate. */
    const qrCode = crypto.randomBytes(16).toString("hex");
    const qrImage = await QRCode.toDataURL(qrCode);

    const event = await Event.findById(payment.event);
    const tierConfig = event?.ticketTypes.find(
      (t) => t.name === payment.ticketType,
    );
    const groupSize = Math.max(1, tierConfig?.groupSize || 1);

    const ticket = await Ticket.create({
      event: payment.event,
      organizer: payment.organizer,
      buyerEmail: payment.email,
      ticketType: payment.ticketType,
      amountPaid: payment.amount,
      paymentRef: payment.reference,
      qrCode,
      qrImage,
      groupSize,
      admittedCount: 0,
    });

    // Update Wallet
    await Wallet.findOneAndUpdate(
      { organizer: payment.organizer },
      {
        $inc: {
          balance: payment.organizerAmount,
          totalEarnings: payment.organizerAmount,
        },
      },
      { upsert: true, new: true },
    );

    // 💸 Ambassador 5% commission (non-blocking, idempotent)
    import("../services/commission.service.js")
      .then(({ creditAmbassadorCommission }) =>
        creditAmbassadorCommission(payment),
      )
      .catch(() => {});

    /* 📧 Ticket confirmation email (non-blocking) */
    try {
      const eventName = event?.title || "Your Event";
      const eventDate = event?.date
        ? new Date(event.date).toLocaleDateString("en-NG", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : "TBD";
      const groupNote =
        groupSize > 1
          ? `<p style="color:#666;margin:8px 0;"><strong>Admits:</strong> ${groupSize} guests on this one QR code</p>`
          : "";

      sendEmail({
        to: payment.email,
        subject: `Your Ticket for ${eventName} is Ready! 🎟️`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:32px;">
            <h1 style="color:#1a1a1a;margin-bottom:8px;">Ticket Confirmed! ✅</h1>
            <p style="color:#666;margin-bottom:20px;">Your payment was successful.</p>

            <div style="background:white;padding:24px;border-radius:12px;margin:24px 0;border-left:4px solid #E8C96A;">
              <h3 style="color:#1a1a1a;margin-top:0;">${eventName}</h3>
              <p style="color:#666;margin:8px 0;">
                <strong>Date:</strong> ${eventDate}<br>
                <strong>Ticket Type:</strong> ${payment.ticketType}<br>
                <strong>Amount Paid:</strong> ₦${payment.amount.toLocaleString()}
              </p>
              ${groupNote}
              <p style="color:#999;font-size:12px;margin:16px 0 0 0;">
                <strong>Ref:</strong> ${payment.reference}
              </p>
            </div>

            <div style="background:#f5f5f5;padding:20px;border-radius:12px;text-align:center;margin:24px 0;">
              <p style="color:#666;margin:0 0 12px 0;font-size:12px;">Your QR Code:</p>
              <img src="${PUBLIC_API}/api/tickets/qr/${payment.reference}" alt="Ticket QR" width="200" height="200" style="width:200px;height:200px;display:inline-block;" />
            </div>

            <p style="color:#999;font-size:12px;">
              Present this QR code at the entrance. No printing needed!
            </p>

            <a href="${process.env.FRONTEND_URL}/success/${payment.reference}" style="display:inline-block;background:#E8C96A;color:#0F0618;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600;margin:24px 0;">
              View My Ticket
            </a>

            <p style="color:#999;font-size:12px;margin-top:32px;">
              © ${new Date().getFullYear()} Tictify. All rights reserved.
            </p>
          </div>
        `,
      })
        .then((result) => {
          if (result?.success) {
            return Ticket.updateOne(
              { paymentRef: payment.reference },
              { emailedAt: new Date() },
            );
          }
        })
        .catch((err) => console.error("Ticket email failed:", err.message));
    } catch (emailErr) {
      console.error("Email sending error:", emailErr.message);
    }

    return res.redirect(
      `${process.env.FRONTEND_URL}/success/${payment.reference}`,
    );
  } catch (err) {
    console.error("PAYMENT SUCCESS ERROR:", err);
    return res.redirect(`${process.env.FRONTEND_URL}/error`);
  }
};
