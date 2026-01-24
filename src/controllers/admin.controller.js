import User from "../models/User.js";
import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";

export const getAdminOrganizers = async (req, res) => {
  try {
    const organizers = await User.find({ role: "organizer" });

    const data = await Promise.all(
      organizers.map(async (org) => {
        const events = await Event.countDocuments({ organizer: org._id });
        const tickets = await Ticket.find({ organizer: org._id });

        return {
          _id: org._id,
          name: org.name,
          email: org.email,
          events,
          ticketsSold: tickets.length,
          revenue: tickets.reduce((sum, t) => sum + (t.amountPaid || 0), 0),
        };
      }),
    );

    // sort by revenue DESC
    data.sort((a, b) => b.revenue - a.revenue);

    res.json(data);
  } catch (err) {
    console.error("ADMIN ORGANIZERS ERROR:", err);
    res.status(500).json({ message: "Failed to load organizers" });
  }
};
export const getAdminEvents = async (req, res) => {
  try {
    const events = await Event.find()
      .populate("organizer", "name email")
      .sort("-createdAt");

    const data = await Promise.all(
      events.map(async (e) => {
        const ticketsSold = await Ticket.countDocuments({
          event: e._id,
        });

        return {
          _id: e._id,
          title: e.title,
          date: e.date,
          capacity: e.capacity,
          ticketsSold,
          status: e.status,
          organizerName: e.organizer?.name || "Unknown",
          organizerEmail: e.organizer?.email || "",
        };
      }),
    );

    res.json(data);
  } catch (err) {
    console.error("ADMIN EVENTS ERROR:", err);
    res.status(500).json({ message: "Failed to load events" });
  }
};
/* ================= ADMIN ANALYTICS ================= */
export const getAdminAnalytics = async (_, res) => {
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

  const topEvents = await Ticket.aggregate([
    {
      $group: {
        _id: "$event",
        revenue: { $sum: "$amountPaid" },
        sold: { $sum: 1 },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 5 },
    {
      $lookup: {
        from: "events",
        localField: "_id",
        foreignField: "_id",
        as: "event",
      },
    },
    { $unwind: "$event" },
  ]);

  const topOrganizers = await Ticket.aggregate([
    {
      $group: {
        _id: "$organizer",
        revenue: { $sum: "$amountPaid" },
        sold: { $sum: 1 },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 5 },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "organizer",
      },
    },
    { $unwind: "$organizer" },
  ]);

  res.json({
    revenueByMonth,
    ticketsByMonth,
    topEvents,
    topOrganizers,
  });
};
