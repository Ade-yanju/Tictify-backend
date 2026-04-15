import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import User from "../models/User.js";

export const organizerDashboard = async (req, res) => {
  try {
    const organizerId = req.user.id;
    const now = new Date();

    // UPGRADE 1: Parallel data fetching & .lean() for raw JS performance
    const [organizer, events, tickets, wallet] = await Promise.all([
      User.findById(organizerId).select("name email avatar").lean(),
      Event.find({ organizer: organizerId }).sort({ date: -1 }).lean(),
      Ticket.find({ organizer: organizerId }).lean(),
      Wallet.findOneAndUpdate(
        { organizer: organizerId },
        {
          $setOnInsert: {
            organizer: organizerId,
            balance: 0,
            totalEarnings: 0,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean(),
    ]);

    // Basic event counts
    const totalEvents = events.length;
    let upcoming = 0;
    let live = 0;
    events.forEach((e) => {
      if (new Date(e.date) > now) upcoming++;
      if (e.status === "LIVE") live++;
    });

    // UPGRADE 2: O(N) Hash Map for ticket stats (Performance Optimization)
    let ticketsSold = 0;
    let totalRevenue = 0;
    const ticketStatsByEvent = {};

    tickets.forEach((t) => {
      const eventId = String(t.event);
      const paid = t.amountPaid || 0;

      ticketsSold++;
      totalRevenue += paid;

      if (!ticketStatsByEvent[eventId]) {
        ticketStatsByEvent[eventId] = { sold: 0, revenue: 0 };
      }
      ticketStatsByEvent[eventId].sold += 1;
      ticketStatsByEvent[eventId].revenue += paid;
    });

    // Map events to include calculated stats
    const eventStats = events.map((event) => {
      const stats = ticketStatsByEvent[String(event._id)] || {
        sold: 0,
        revenue: 0,
      };
      return {
        _id: event._id,
        title: event.title,
        date: event.date,
        capacity: event.capacity,
        sold: stats.sold,
        status: event.status,
        revenue: stats.revenue,
      };
    });

    return res.json({
      organizer: {
        name: organizer?.name || "Organizer",
        email: organizer?.email || "",
        avatar: organizer?.avatar || null,
      },
      stats: {
        events: totalEvents,
        ticketsSold,
        revenue: totalRevenue,
        upcoming,
        live,
        walletBalance: wallet?.balance || 0,
        totalEarnings: wallet?.totalEarnings || 0,
      },
      events: eventStats,
    });
  } catch (error) {
    console.error("DASHBOARD ERROR:", error);
    res.status(500).json({ message: "Failed to load unique organizer data." });
  }
};
