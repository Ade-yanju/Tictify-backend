import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";
import mongoose from "mongoose";
import QRCode from "qrcode";

/* =====================================================
   GET TICKET BY PAYMENT REFERENCE (SUCCESS PAGE)
===================================================== */
export const getTicketByReference = async (req, res) => {
  const { reference } = req.params;

  const ticket = await Ticket.findOne({ paymentRef: reference }).populate(
    "event",
  );

  // 👇 THIS IS THE FIX
  if (!ticket) {
    return res.json({ status: "PENDING" });
  }

  const qrImage = await QRCode.toDataURL(ticket.qrCode);

  return res.json({
    status: "READY",
    event: {
      title: ticket.event.title,
      date: ticket.event.date,
      location: ticket.event.location,
    },
    ticket: {
      ticketType: ticket.ticketType,
      qrImage,
    },
  });
};

/* =====================================================
   ORGANIZER TICKET SALES & ANALYTICS
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

    const eventsAgg = await Ticket.aggregate([
      { $match: { organizer: organizerId } },
      {
        $lookup: {
          from: "events",
          localField: "event",
          foreignField: "_id",
          as: "event",
        },
      },
      { $unwind: "$event" },
      {
        $group: {
          _id: "$event._id",
          title: { $first: "$event.title" },
          status: { $first: "$event.status" },
          date: { $first: "$event.date" },
          ticketsSold: { $sum: 1 },
          revenue: { $sum: "$amountPaid" },
          scanned: {
            $sum: { $cond: [{ $eq: ["$scanned", true] }, 1, 0] },
          },
        },
      },
      { $sort: { ticketsSold: -1 } },
    ]);

    return res.json({
      stats,
      events: eventsAgg.map((e) => ({
        eventId: e._id,
        title: e.title,
        status: e.status,
        date: e.date,
        ticketsSold: e.ticketsSold,
        scanned: e.scanned,
        unscanned: e.ticketsSold - e.scanned,
        revenue: e.revenue,
      })),
    });
  } catch (error) {
    console.error("TICKET SALES ERROR:", error);
    return res.status(500).json({ message: "Failed to load ticket sales" });
  }
};

/* =====================================================
   SCAN TICKET (ORGANIZER ONLY)
===================================================== */
export const scanTicketController = async (req, res) => {
  try {
    const { code, eventId } = req.body;
    const organizerId = req.user._id;

    if (!code || !eventId) {
      return res.status(400).json({ message: "Invalid scan data" });
    }

    /* 1️⃣ VERIFY EVENT OWNERSHIP */
    const event = await Event.findOne({
      _id: eventId,
      organizer: organizerId,
      status: "LIVE",
    });

    if (!event) {
      return res.status(403).json({
        message: "You are not authorized to scan tickets for this event",
      });
    }

    /* 2️⃣ FIND TICKET */
    const ticket = await Ticket.findOne({
      qrCode: code,
      event: eventId,
    });

    if (!ticket) {
      return res.status(404).json({ message: "Invalid ticket" });
    }

    /* 3️⃣ ALREADY USED */
    if (ticket.scanned) {
      return res.status(409).json({ message: "Ticket already used" });
    }

    /* 4️⃣ MARK AS SCANNED */
    ticket.scanned = true;
    ticket.scannedAt = new Date();
    await ticket.save();

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

    const ticketCode = crypto.randomBytes(16).toString("hex");
    const qrImage = await generateQRCode(ticketCode);

    await Ticket.create({
      event: event._id,
      organizer: event.organizer,
      buyerEmail: payment.email,
      qrCode: crypto.randomBytes(16).toString("hex"),
      qrImage: null, // generated lazily
      ticketType: payment.ticketType,
      paymentRef: ref,
      amountPaid: payment.organizerAmount,
      currency: "NGN",
      scanned: false,
    });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: "Failed to create free ticket" });
  }
};
