// controllers/admin.analytics.controller.js
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";

export const adminAnalytics = async (req, res) => {
  try {
    const revenueByMonth = await Ticket.aggregate([
      {
        $group: {
          _id: { $month: "$createdAt" },
          total: { $sum: "$amountPaid" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const ticketsByMonth = await Ticket.aggregate([
      {
        $group: {
          _id: { $month: "$createdAt" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const eventsByMonth = await Event.aggregate([
      {
        $group: {
          _id: { $month: "$createdAt" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    /* ================= NEW: PLATFORM FEES ================= */
    const platformFeesByMonth = await Ticket.aggregate([
      {
        $group: {
          _id: { $month: "$createdAt" },
          total: {
            $sum: {
              $add: [{ $multiply: ["$amountPaid", 0.03] }, 80],
            },
          },
        },
      },
      {
        $project: {
          _id: 1,
          total: { $round: ["$total", 0] },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      revenueByMonth,
      ticketsByMonth,
      eventsByMonth,
      platformFeesByMonth, // ✅ NEW (non-breaking)
    });
  } catch (err) {
    console.error("ADMIN ANALYTICS ERROR:", err);
    res.status(500).json({ message: "Analytics failed" });
  }
};
