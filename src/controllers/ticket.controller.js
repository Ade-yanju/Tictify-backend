import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import { sendEmail } from "../services/email.service.js";

/* Public base URL of THIS backend — used for QR image links in emails
   (email clients block base64 data-URI images) */
const PUBLIC_API =
  process.env.BACKEND_URL || "https://tictify-backend.onrender.com";

/* =====================================================
   🚪 LIVE GATE STATS — admitted vs sold, polled during
   the event by the scanner page (organizer only)
===================================================== */
export const getGateStats = async (req, res) => {
  try {
    const { eventId } = req.params;
    const event = await Event.findById(eventId);
    if (!event || event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    const agg = await Ticket.aggregate([
      { $match: { event: event._id } },
      {
        $group: {
          _id: null,
          ticketsSold: { $sum: 1 },
          guestsExpected: { $sum: { $ifNull: ["$groupSize", 1] } },
          guestsAdmitted: { $sum: { $ifNull: ["$admittedCount", 0] } },
        },
      },
    ]);

    const s = agg[0] || { ticketsSold: 0, guestsExpected: 0, guestsAdmitted: 0 };
    return res.json({
      eventTitle: event.title,
      ticketsSold: s.ticketsSold,
      guestsExpected: s.guestsExpected,
      guestsAdmitted: s.guestsAdmitted,
      guestsRemaining: Math.max(0, s.guestsExpected - s.guestsAdmitted),
    });
  } catch (err) {
    console.error("GATE STATS ERROR:", err);
    return res.status(500).json({ message: "Failed to load gate stats" });
  }
};

/* =====================================================
   📣 PROMOTER LEADERBOARD — sales per ?ref= code
   (organizer only, per event)
===================================================== */
export const getPromoterStats = async (req, res) => {
  try {
    const { eventId } = req.params;
    const event = await Event.findById(eventId);
    if (!event || event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    const promoters = await Payment.aggregate([
      {
        $match: {
          event: event._id,
          status: "SUCCESS",
          promoter: { $exists: true, $nin: [null, ""] },
        },
      },
      {
        $group: {
          _id: "$promoter",
          ticketsSold: { $sum: 1 },
          revenue: { $sum: "$organizerAmount" },
        },
      },
      { $sort: { ticketsSold: -1 } },
      { $limit: 50 },
    ]);

    const direct = await Payment.countDocuments({
      event: event._id,
      status: "SUCCESS",
      $or: [{ promoter: { $exists: false } }, { promoter: null }, { promoter: "" }],
    });

    return res.json({
      eventTitle: event.title,
      promoters: promoters.map((p) => ({
        code: p._id,
        ticketsSold: p.ticketsSold,
        revenue: p.revenue,
      })),
      directSales: direct,
    });
  } catch (err) {
    console.error("PROMOTER STATS ERROR:", err);
    return res.status(500).json({ message: "Failed to load promoter stats" });
  }
};

/* =====================================================
   📋 GUEST LIST EXPORT — CSV download (organizer only)
===================================================== */
export const exportGuestList = async (req, res) => {
  try {
    const { eventId } = req.params;
    const event = await Event.findById(eventId);
    if (!event || event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    const tickets = await Ticket.find({ event: event._id }).sort({ createdAt: 1 });

    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      ["Email", "Ticket Type", "Admits", "Admitted", "Status", "Reference", "Purchased"].join(","),
      ...tickets.map((t) =>
        [
          esc(t.buyerEmail),
          esc(t.ticketType),
          t.groupSize || 1,
          t.admittedCount || 0,
          t.scanned ? "USED" : "VALID",
          esc(t.paymentRef),
          esc(t.createdAt?.toISOString?.() || ""),
        ].join(","),
      ),
    ];

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="guestlist-${event.title.replace(/[^a-z0-9]/gi, "-").slice(0, 40)}.csv"`,
    );
    return res.send(rows.join("\n"));
  } catch (err) {
    console.error("GUEST EXPORT ERROR:", err);
    return res.status(500).json({ message: "Export failed" });
  }
};

/* =====================================================
   👛 TICKET WALLET — guest enters their email, we email
   every ticket they own (no enumeration: same response
   whether or not tickets exist)
===================================================== */
export const emailMyTickets = async (req, res) => {
  const neutral = {
    message:
      "If any tickets are linked to that email, they're on their way to your inbox.",
  };

  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "A valid email is required" });
    }

    const tickets = await Ticket.find({ buyerEmail: email })
      .populate("event", "title date location")
      .sort({ createdAt: -1 })
      .limit(20);

    if (tickets.length > 0) {
      const rows = tickets
        .map((t) => {
          const ev = t.event || {};
          const when = ev.date ? new Date(ev.date).toDateString() : "—";
          const admits =
            (t.groupSize || 1) > 1 ? ` · admits ${t.groupSize}` : "";
          return `
            <div style="background:#fff;padding:16px 20px;border-radius:12px;margin:10px 0;border-left:4px solid #E8C96A;">
              <p style="margin:0 0 4px;font-weight:bold;">${ev.title || "Event"}</p>
              <p style="margin:0 0 10px;color:#666;font-size:13px;">${when} · ${ev.location || ""} · ${t.ticketType || "Ticket"}${admits}</p>
              <a href="${process.env.FRONTEND_URL}/success/${t.paymentRef}"
                 style="display:inline-block;background:#E8C96A;color:#000;padding:9px 18px;border-radius:50px;text-decoration:none;font-weight:bold;font-size:13px;">
                Open ticket & QR code
              </a>
            </div>`;
        })
        .join("");

      sendEmail({
        to: email,
        subject: `Your Tictify wallet — ${tickets.length} ticket${tickets.length > 1 ? "s" : ""} 🎟️`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#f9fafb;border-radius:16px;">
            <h2 style="color:#1a1a1a;margin-top:0;">Your tickets, all in one place</h2>
            <p style="color:#666;">Here's everything linked to ${email}:</p>
            ${rows}
            <p style="font-size:12px;color:#999;margin-top:26px;">Show the QR code at the entrance — no printing needed. © ${new Date().getFullYear()} Tictify.</p>
          </div>
        `,
      }).catch((err) => console.error("Wallet email failed:", err.message));
    }

    return res.json(neutral);
  } catch (err) {
    console.error("MY TICKETS ERROR:", err);
    return res.json(neutral);
  }
};

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
          <div style="text-align:center;background:#f8f9fa;padding:20px;border-radius:12px;margin:24px 0;">
            <p style="font-size:12px;color:#888;margin:0 0 10px;">Show this QR code at the entrance</p>
            <img src="${PUBLIC_API}/api/tickets/qr/${reference}" alt="Ticket QR" width="200" height="200" style="width:200px;height:200px;display:inline-block;" />
          </div>
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
        emailUnavailable: true,
        message:
          "Email delivery is unstable right now — please download your ticket instead. It works exactly the same at the gate.",
      });
    }

    await Ticket.updateOne(
      { paymentRef: reference },
      { emailedAt: new Date() },
    );

    return res.json({ success: true, message: "Email delivered successfully." });
  } catch (error) {
    console.error("CRITICAL EMAIL SYSTEM ERROR:", error);
    return res.status(500).json({ message: "Internal server failure." });
  }
};

/* =====================================================
   🖼️ QR IMAGE AS A REAL URL
   Gmail/Outlook strip base64 data-URI images from emails,
   so ticket emails point at this endpoint instead.
===================================================== */
export const getTicketQrImage = async (req, res) => {
  try {
    const { reference } = req.params;
    const ticket = await Ticket.findOne({ paymentRef: reference });
    if (!ticket || !ticket.qrCode) return res.status(404).send("Not found");

    const png = await QRCode.toBuffer(ticket.qrCode, {
      type: "png",
      width: 400,
      margin: 2,
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.send(png);
  } catch (err) {
    console.error("QR IMAGE ERROR:", err);
    return res.status(500).send("QR unavailable");
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
        groupSize: ticket.groupSize || 1,
        admittedCount: ticket.admittedCount || 0,
        emailed: Boolean(ticket.emailedAt),
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
