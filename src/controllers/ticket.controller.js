import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import fetch from "node-fetch";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";

/* =====================================================
   📧 SEND TICKET VIA SENDCHAMP (STRICT v1 COMPLIANCE)
===================================================== */
export const sendTicketViaEmail = async (req, res) => {
  try {
    const { email, reference } = req.body;

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

    // 2. Prepare Payload (Strict Object Structure for SendChamp)
    const payload = {
      subject: `Your Ticket for ${ticket.event.title}`,
      to: [
        {
          email: email,
          name: "Valued Guest",
        },
      ],
      from: {
        email: "support@tictify.ng", // Must be a verified domain in SendChamp
        name: "Tictify",
      },
      message_body: {
        type: "text/html",
        value: `
          <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #f0f0f0; border-radius: 16px;">
            <h2 style="color: #1F0D33;">Success! Your ticket is ready.</h2>
            <p>Hi there, we've confirmed your purchase for <strong>${ticket.event.title}</strong>.</p>
            <div style="background: #f8f9fa; padding: 20px; border-radius: 12px; margin: 24px 0;">
               <p style="margin: 4px 0;"><strong>Ticket Type:</strong> ${ticket.ticketType}</p>
               <p style="margin: 4px 0;"><strong>Date:</strong> ${new Date(ticket.event.date).toDateString()}</p>
               <p style="margin: 4px 0;"><strong>Location:</strong> ${ticket.event.location}</p>
               <p style="margin: 4px 0;"><strong>Reference:</strong> <code style="color: #22F2A6;">${reference}</code></p>
            </div>
            <a href="${process.env.FRONTEND_URL}/success/${reference}" 
               style="display: inline-block; background: #22F2A6; color: #000; padding: 14px 28px; text-decoration: none; border-radius: 50px; font-weight: bold; text-align: center;">
               Access Your QR Code
            </a>
            <p style="font-size: 12px; color: #888; margin-top: 30px; text-align: center;">
              Powered by Tictify. Please have your QR code ready at the entrance.
            </p>
          </div>
        `,
      },
    };

    // 3. Request to SendChamp
    const response = await fetch(
      "https://api.sendchamp.com/api/v1/email/send",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SENDCHAMP_KEY}`,
        },
        body: JSON.stringify(payload),
      },
    );

    const data = await response.json();

    // Check for success status or 200/201 codes
    if (response.ok && (data.status === "success" || data.code <= 201)) {
      return res.json({
        success: true,
        message: "Email delivered successfully.",
      });
    } else {
      console.error("SENDCHAMP FAILURE LOG:", JSON.stringify(data, null, 2));
      return res.status(400).json({
        message: "Email provider error",
        error: data.message || "Provider rejected the request",
      });
    }
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
   🔥 ATOMIC SCANNER (THREAD-SAFE)
===================================================== */
export const scanTicketController = async (req, res) => {
  try {
    const { code, eventId } = req.body;
    if (!code || !eventId)
      return res.status(400).json({ message: "Invalid scan" });

    const event = await Event.findById(eventId);
    if (!event || event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    const ticket = await Ticket.findOneAndUpdate(
      { qrCode: code, event: eventId, scanned: false },
      { scanned: true, scannedAt: new Date() },
      { new: true },
    );

    if (!ticket) {
      const alreadyScanned = await Ticket.findOne({
        qrCode: code,
        event: eventId,
      });
      return alreadyScanned
        ? res.status(409).json({ message: "Ticket already used" })
        : res.status(404).json({ message: "Ticket not found" });
    }

    return res.json({
      message: "Access granted",
      attendee: ticket.buyerEmail,
      ticketType: ticket.ticketType,
    });
  } catch (error) {
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

    res.json({ success: true, reference: paymentRef });
  } catch (err) {
    res.status(500).json({ message: "Failed to create free ticket" });
  }
};
