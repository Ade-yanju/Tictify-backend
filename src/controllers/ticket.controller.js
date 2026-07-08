import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";
import { sendEmail } from "../services/email.service.js";

/* =====================================================
   📧 SEND TICKET EMAIL (multi-provider: Brevo/Gmail SMTP,
   Resend, SendGrid, Mailgun — set EMAIL_PROVIDER in .env)
===================================================== */
export const sendTicketViaEmail = async (req, res) => {
  try {
    const { reference } = req.body;
    const email = String(req.body.email || "").trim().toLowerCase();

    if (!email || !reference) {
      return res
        .status(400)
        .json({ message: "Email and Reference are required" });
    }

    // 1. Fetch ticket & event data
    const ticket = await Ticket.findOne({ paymentRef: reference }).populate(
      "event",
    );
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    const groupNote =
      (ticket.groupSize || 1) > 1
        ? `<p style="margin: 4px 0;"><strong>Admits:</strong> ${ticket.groupSize} guests on one QR code</p>`
        : "";

    // 2. Send through the configured provider (with auto-fallback)
    const result = await sendEmail({
      to: email,
      subject: `Your Ticket for ${ticket.event.title}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #f0f0f0; border-radius: 16px;">
          <h2 style="color: #1F0D33;">Success! Your ticket is ready.</h2>
          <p>Hi there, we've confirmed your purchase for <strong>${ticket.event.title}</strong>.</p>
          <div style="background: #f8f9fa; padding: 20px; border-radius: 12px; margin: 24px 0;">
             <p style="margin: 4px 0;"><strong>Ticket Type:</strong> ${ticket.ticketType}</p>
             ${groupNote}
             <p style="margin: 4px 0;"><strong>Date:</strong> ${new Date(ticket.event.date).toDateString()}</p>
             <p style="margin: 4px 0;"><strong>Location:</strong> ${ticket.event.location}</p>
             <p style="margin: 4px 0;"><strong>Reference:</strong> <code style="color: #B8952E;">${reference}</code></p>
          </div>
          ${
            ticket.qrImage
              ? `<div style="text-align:center;background:#f8f9fa;padding:20px;border-radius:12px;margin:24px 0;">
                   <p style="font-size:12px;color:#888;margin:0 0 10px;">Show this QR code at the entrance</p>
                   <img src="${ticket.qrImage}" alt="Ticket QR" style="width:200px;height:200px;" />
                 </div>`
              : ""
          }
          <a href="${process.env.FRONTEND_URL}/success/${reference}"
             style="display: inline-block; background: #E8C96A; color: #000; padding: 14px 28px; text-decoration: none; border-radius: 50px; font-weight: bold; text-align: center;">
             Access Your QR Code
          </a>
          <p style="font-size: 12px; color: #888; margin-top: 30px; text-align: center;">
            Powered by Tictify. Please have your QR code ready at the entrance.
          </p>
        </div>
      `,
    });

    if (result?.success === false) {
      return res.status(502).json({
        message: "Email provider not configured or rejected the request",
      });
    }

    return res.json({ success: true, message: "Email delivered successfully." });
  } catch (error) {
    console.error("CRITICAL EMAIL SYSTEM ERROR:", error);
    return res.status(500).json({ message: "Internal server failure." });
  }
};

/* =====================================================
   GET TICKET BY PAYMENT REFERENCE
===================================================== */
export const getTicketByReference = async (req, res) => {
  try {
    const { reference } = req.params;
    if (!reference) return res.json({ status: "PENDING" });

    const ticket = await Ticket.findOne({ paymentRef: reference }).populate(
      "event",
    );
    if (!ticket || !ticket.qrImage) return res.json({ status: "PENDING" });

    return res.json({
      status: "READY",
      event: {
        title: ticket.event.title,
        date: ticket.event.date,
        location: ticket.event.location,
        banner: ticket.event.banner,
      },
      ticket: {
        ticketType: ticket.ticketType,
        qrImage: ticket.qrImage,
        buyerEmail: ticket.buyerEmail,
      },
    });
  } catch (err) {
    console.error("DATA FETCH ERROR:", err);
    return res.status(500).json({ status: "ERROR" });
  }
};

/* =====================================================
   🔥 ATOMIC SCANNER (THREAD-SAFE, GROUP-AWARE)
   Accepts any of:
   - the QR payload (hex code, or legacy "TICKET:<ref>:<email>")
   - a manually typed payment reference (any case)
===================================================== */
export const scanTicketController = async (req, res) => {
  try {
    const { code, eventId } = req.body;
    if (!code || typeof code !== "string") {
      return res.status(400).json({ message: "Ticket code is required" });
    }

    /* ── Normalize the scanned/typed code ── */
    const raw = code.trim();
    const or = [];
    if (raw.toUpperCase().startsWith("TICKET:")) {
      // legacy QR payload: TICKET:<reference>:<email>
      const ref = raw.split(":")[1]?.trim();
      if (ref) or.push({ paymentRef: ref }, { paymentRef: ref.toUpperCase() });
    } else {
      // hex qr code, or a reference typed by hand
      or.push(
        { qrCode: raw },
        { qrCode: raw.toLowerCase() },
        { paymentRef: raw },
        { paymentRef: raw.toUpperCase() },
      );
    }
    if (or.length === 0) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    /* ── Locate the ticket (case-insensitive for typed codes) ── */
    const lookup = eventId ? { $or: or, event: eventId } : { $or: or };
    const found = await Ticket.findOne(lookup)
      .collation({ locale: "en", strength: 2 })
      .populate("event");
    if (!found) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    /* ── Ownership: only this event's organizer may admit ── */
    const eventOrganizer =
      found.event?.organizer?.toString() || found.organizer?.toString();
    if (!eventOrganizer || eventOrganizer !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "You are not authorized to scan this ticket" });
    }

    /* ── Atomic group admission (prevents double-admit races) ── */
    const groupSize = Math.max(1, found.groupSize || 1);
    const ticket = await Ticket.findOneAndUpdate(
      {
        _id: found._id,
        scanned: { $ne: true }, // legacy fully-used tickets stay rejected
        $expr: { $lt: [{ $ifNull: ["$admittedCount", 0] }, groupSize] },
      },
      {
        $inc: { admittedCount: 1 },
        $set: { scannedAt: new Date() },
      },
      { new: true },
    );

    // Final guest in the group → mark the ticket fully used
    if (ticket && ticket.admittedCount >= groupSize && !ticket.scanned) {
      ticket.scanned = true;
      await ticket.save();
    }

    if (!ticket) {
      return res.status(409).json({
        message:
          groupSize > 1
            ? `Ticket fully used — all ${groupSize} guests already admitted`
            : "Ticket already used",
      });
    }

    return res.json({
      message:
        groupSize > 1
          ? `Access granted — guest ${ticket.admittedCount} of ${groupSize}`
          : "Access granted",
      attendee: ticket.buyerEmail,
      ticketType: ticket.ticketType,
      admitted: ticket.admittedCount,
      groupSize,
      remaining: groupSize - ticket.admittedCount,
    });
  } catch (error) {
    console.error("SCAN ERROR:", error);
    return res.status(500).json({ message: "Scan processing error" });
  }
};

/* =====================================================
   ORGANIZER SALES & FREE TICKET GENERATION
===================================================== */
export const getOrganizerTicketSales = async (req, res) => {
  try {
    const organizerId = new mongoose.Types.ObjectId(req.user._id);
    const totalsAgg = await Ticket.aggregate([
      { $match: { organizer: organizerId } },
      {
        $group: {
          _id: null,
          totalTickets: { $sum: 1 },
          scanned: { $sum: { $cond: [{ $eq: ["$scanned", true] }, 1, 0] } },
          unscanned: { $sum: { $cond: [{ $eq: ["$scanned", false] }, 1, 0] } },
          totalRevenue: { $sum: "$amountPaid" },
        },
      },
    ]);

    res.json({
      stats: totalsAgg[0] || {
        totalTickets: 0,
        scanned: 0,
        unscanned: 0,
        totalRevenue: 0,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load sales" });
  }
};

export const createFreeTicket = async (req, res) => {
  try {
    const { eventId, email, ticketType } = req.body;
    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE")
      return res.status(400).json({ message: "Invalid event" });

    const paymentRef = `FREE-${crypto.randomBytes(8).toString("hex")}`;
    const qrCode = crypto.randomBytes(16).toString("hex");
    const qrImage = await QRCode.toDataURL(qrCode);
    const tierConfig = event.ticketTypes.find((t) => t.name === ticketType);

    await Ticket.create({
      event: event._id,
      organizer: event.organizer,
      buyerEmail: email,
      qrCode,
      qrImage,
      ticketType,
      paymentRef,
      amountPaid: 0,
      currency: "NGN",
      scanned: false,
      groupSize: Math.max(1, tierConfig?.groupSize || 1),
      admittedCount: 0,
    });

    res.json({ success: true, reference: paymentRef });
  } catch (err) {
    res.status(500).json({ message: "Failed to create free ticket" });
  }
};
