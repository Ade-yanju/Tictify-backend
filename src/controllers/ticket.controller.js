import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";

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
      },
      ticket: {
        ticketType: ticket.ticketType,
        qrImage: ticket.qrImage,
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

    /* ---------- VERIFY EVENT ---------- */
    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    if (event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        message: "You are not authorized to scan tickets for this event",
      });
    }

    if (event.status !== "LIVE") {
      return res.status(400).json({
        message: "Event is not live for scanning",
      });
    }

    /* =====================================================
       🔥 ATOMIC UPDATE (NO COLLISION POSSIBLE)
    ===================================================== */

    const ticket = await Ticket.findOneAndUpdate(
      {
        qrCode: code,
        event: eventId,
        scanned: false, // critical condition
      },
      {
        scanned: true,
        scannedAt: new Date(),
      },
      {
        new: true,
      },
    );

    /* ---------- INVALID OR ALREADY USED ---------- */
    if (!ticket) {
      const alreadyUsed = await Ticket.findOne({
        qrCode: code,
        event: eventId,
      });

      if (alreadyUsed) {
        return res.status(409).json({
          message: "Ticket already used",
        });
      }

      return res.status(404).json({
        message: "Invalid ticket",
      });
    }

    /* ---------- SUCCESS ---------- */
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
      return res.status(400).json({ message: "Invalid event" });
    }

    const ticketConfig = event.ticketTypes.find(
      (t) => t.name === ticketType && t.price === 0,
    );

    if (!ticketConfig) {
      return res.status(400).json({ message: "Invalid free ticket" });
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

    return res.json({ success: true });
  } catch (err) {
    console.error("FREE TICKET ERROR:", err);
    return res.status(500).json({ message: "Failed to create free ticket" });
  }
};
