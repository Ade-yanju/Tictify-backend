// controllers/admin.analytics.controller.js
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";

export const adminAnalytics = async (req, res) => {
  const revenueByMonth = await Ticket.aggregate([
    {
      $group: {
        _id: { $month: "$createdAt" },
        total: { $sum: "$amountPaid" },
      },
    },
  ]);

  const ticketsByMonth = await Ticket.aggregate([
    {
      $group: {
        _id: { $month: "$createdAt" },
        count: { $sum: 1 },
      },
    },
  ]);

  const eventsByMonth = await Event.aggregate([
    {
      $group: {
        _id: { $month: "$createdAt" },
        count: { $sum: 1 },
      },
    },
  ]);

  res.json({
    revenueByMonth,
    ticketsByMonth,
    eventsByMonth,
  });
};
