import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import fetch from "node-fetch";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";

/* =====================================================
   📧 SEND TICKET VIA SENDCHAMP
===================================================== */
export const sendTicketViaEmail = async (req, res) => {
  try {
    const { email, reference } = req.body;

    if (!email || !reference) {
      return res
        .status(400)
        .json({ message: "Email and Reference are required" });
    }

    // 1. Find the ticket and populate event details
    const ticket = await Ticket.findOne({ paymentRef: reference }).populate(
      "event",
    );

    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    // 2. Call SendChamp API
    // Ensure SENDCHAMP_KEY in your .env is the "Public access key" from your dashboard
    const response = await fetch(
      "https://api.sendchamp.com/api/v1/email/send",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SENDCHAMP_KEY}`,
        },
        body: JSON.stringify({
          to: [{ email: email, name: "Attendee" }],
          from: "Tictify", // Must be a verified Sender Name in your SendChamp account
          subject: `Your Ticket for ${ticket.event.title}`,
          message_body: `
          <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px;">
            <h2 style="color: #1F0D33;">Your Ticket is Ready!</h2>
            <p>Hi, your ticket for <strong>${ticket.event.title}</strong> has been confirmed.</p>
            <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
               <p><strong>Ticket Type:</strong> ${ticket.ticketType}</p>
               <p><strong>Date:</strong> ${new Date(ticket.event.date).toDateString()}</p>
               <p><strong>Location:</strong> ${ticket.event.location}</p>
               <p><strong>Reference:</strong> ${reference}</p>
            </div>
            <a href="${process.env.FRONTEND_URL}/success/${reference}" 
               style="display: inline-block; background: #22F2A6; color: #000; padding: 12px 25px; text-decoration: none; border-radius: 30px; font-weight: bold;">
               View QR Code & Download PDF
            </a>
            <p style="font-size: 12px; color: #777; margin-top: 25px;">
              If the button above doesn't work, copy and paste this link: <br/>
              ${process.env.FRONTEND_URL}/success/${reference}
            </p>
          </div>
        `,
        }),
      },
    );

    const data = await response.json();

    if (response.ok || data.status === "success") {
      return res.json({ success: true, message: "Ticket sent to your email!" });
    } else {
      console.error("SendChamp API Error:", data);
      return res
        .status(500)
        .json({ message: "Email service failed to deliver." });
    }
  } catch (error) {
    console.error("SEND EMAIL ERROR:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* =====================================================
   GET TICKET BY PAYMENT REFERENCE
===================================================== */
export const getTicketByReference = async (req, res) => {
  try {
    const { reference } = req.params;

    if (!reference) {
      return res.json({ status: "PENDING" });
    }

    const ticket = await Ticket.findOne({
      paymentRef: reference,
    }).populate("event");

    if (!ticket || !ticket.qrImage) {
      return res.json({ status: "PENDING" });
    }

    return res.json({
      status: "READY",
      event: {
        title: ticket.event.title,
        date: ticket.event.date,
        location: ticket.event.location,
        banner: ticket.event.banner, // Required for frontend PDF generation
      },
      ticket: {
        ticketType: ticket.ticketType,
        qrImage: ticket.qrImage,
        buyerEmail: ticket.buyerEmail, // Required for guest info on success page
      },
    });
  } catch (err) {
    console.error("GET TICKET ERROR:", err);
    return res.status(500).json({ status: "ERROR" });
  }
};

/* =====================================================
   ORGANIZER SALES
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
          scanned: {
            $sum: { $cond: [{ $eq: ["$scanned", true] }, 1, 0] },
          },
          unscanned: {
            $sum: { $cond: [{ $eq: ["$scanned", false] }, 1, 0] },
          },
          totalRevenue: { $sum: "$amountPaid" },
        },
      },
    ]);

    const stats = totalsAgg[0] || {
      totalTickets: 0,
      scanned: 0,
      unscanned: 0,
      totalRevenue: 0,
    };

    return res.json({ stats });
  } catch (error) {
    console.error("TICKET SALES ERROR:", error);
    return res.status(500).json({ message: "Failed to load ticket sales" });
  }
};

/* =====================================================
   🔥 COLLISION-PROOF SCANNER
===================================================== */
export const scanTicketController = async (req, res) => {
  try {
    const { code, eventId } = req.body;

    if (!code || !eventId) {
      return res.status(400).json({ message: "Invalid scan data" });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: "Event not found" });

    if (event.organizer.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ message: "Unauthorized to scan for this event" });
    }

    if (event.status !== "LIVE") {
      return res
        .status(400)
        .json({ message: "Event is not live for scanning" });
    }

    // Atomic update prevents double-scanning in high-traffic situations
    const ticket = await Ticket.findOneAndUpdate(
      { qrCode: code, event: eventId, scanned: false },
      { scanned: true, scannedAt: new Date() },
      { new: true },
    );

    if (!ticket) {
      const alreadyUsed = await Ticket.findOne({
        qrCode: code,
        event: eventId,
      });
      return alreadyUsed
        ? res.status(409).json({ message: "Ticket already used" })
        : res.status(404).json({ message: "Invalid ticket" });
    }

    return res.json({
      message: "Access granted",
      attendee: ticket.buyerEmail,
      ticketType: ticket.ticketType,
    });
  } catch (error) {
    console.error("SCAN ERROR:", error);
    return res.status(500).json({ message: "Scan failed" });
  }
};

/* =====================================================
   CREATE FREE TICKET
===================================================== */
export const createFreeTicket = async (req, res) => {
  try {
    const { eventId, email, ticketType } = req.body;

    const event = await Event.findById(eventId);
    if (!event || event.status !== "LIVE") {
      return res.status(400).json({ message: "Invalid or inactive event" });
    }

    const ticketConfig = event.ticketTypes.find(
      (t) => t.name === ticketType && t.price === 0,
    );

    if (!ticketConfig) {
      return res
        .status(400)
        .json({ message: "Selected ticket type is not free" });
    }

    const paymentRef = `FREE-${crypto.randomBytes(8).toString("hex")}`;
    const qrCode = crypto.randomBytes(16).toString("hex");
    const qrImage = await QRCode.toDataURL(qrCode);

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
    });

    return res.json({ success: true, reference: paymentRef });
  } catch (err) {
    console.error("FREE TICKET ERROR:", err);
    return res.status(500).json({ message: "Failed to create free ticket" });
  }
};
