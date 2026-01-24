// import Ticket from "../models/Ticket.js";
// import Event from "../models/Event.js";
// import mongoose from "mongoose";

// export const getOrganizerTicketSales = async (req, res) => {
//   try {
//     const organizerId = new mongoose.Types.ObjectId(req.user._id);

//     /* ================= TOTAL STATS ================= */
//     const totals = await Ticket.aggregate([
//       {
//         $lookup: {
//           from: "events",
//           localField: "event",
//           foreignField: "_id",
//           as: "event",
//         },
//       },
//       { $unwind: "$event" },
//       {
//         $match: {
//           "event.organizer": organizerId,
//         },
//       },
//       {
//         $group: {
//           _id: null,
//           totalTickets: { $sum: 1 },
//           scanned: {
//             $sum: { $cond: ["$scanned", 1, 0] },
//           },
//           unscanned: {
//             $sum: { $cond: ["$scanned", 0, 1] },
//           },
//           totalRevenue: {
//             $sum: "$event.ticketPrice",
//           },
//         },
//       },
//     ]);

//     /* ================= EVENT BREAKDOWN ================= */
//     const events = await Ticket.aggregate([
//       {
//         $lookup: {
//           from: "events",
//           localField: "event",
//           foreignField: "_id",
//           as: "event",
//         },
//       },
//       { $unwind: "$event" },
//       {
//         $match: {
//           "event.organizer": organizerId,
//         },
//       },
//       {
//         $group: {
//           _id: "$event._id",
//           title: { $first: "$event.title" },
//           status: { $first: "$event.status" },
//           ticketsSold: { $sum: 1 },
//           revenue: { $sum: "$event.ticketPrice" },
//         },
//       },
//       { $sort: { ticketsSold: -1 } },
//     ]);

//     res.json({
//       stats: totals[0] || {
//         totalTickets: 0,
//         totalRevenue: 0,
//         scanned: 0,
//         unscanned: 0,
//       },
//       events: events.map((e) => ({
//         eventId: e._id,
//         title: e.title,
//         status: e.status,
//         ticketsSold: e.ticketsSold,
//         revenue: e.revenue,
//       })),
//     });
//   } catch (error) {
//     console.error("TICKET SALES ERROR:", error);
//     res.status(500).json({
//       message: "Failed to load ticket sales",
//     });
//   }
// };
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";
import mongoose from "mongoose";
import QRCode from "qrcode";

/* =====================================================
   GET TICKET BY PAYMENT REFERENCE (SUCCESS PAGE)
===================================================== */
export const getTicketByReference = async (req, res) => {
  try {
    const { reference } = req.params;

    if (!reference) {
      return res.status(400).json({ message: "Reference is required" });
    }

    const ticket = await Ticket.findOne({
      paymentRef: reference,
    }).populate("event");

    if (!ticket || !ticket.event) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    const qrImage = await QRCode.toDataURL(ticket.qrCode);

    return res.json({
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
  } catch (error) {
    console.error("GET TICKET ERROR:", error);
    return res.status(500).json({ message: "Failed to load ticket" });
  }
};

/* =====================================================
   ORGANIZER TICKET SALES & ANALYTICS
===================================================== */
export const getOrganizerTicketSales = async (req, res) => {
  try {
    const organizerId = new mongoose.Types.ObjectId(req.user._id);

    /* ================= OVERALL STATS ================= */
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

    /* ================= EVENT BREAKDOWN ================= */
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
    res.status(500).json({ message: "Failed to load ticket sales" });
  }
};
