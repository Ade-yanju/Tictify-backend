import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";

export const organizerDashboard = async (req, res) => {
  try {
    const organizerId = req.user.id;

    /* ================= EVENTS ================= */
    const events = await Event.find({ organizer: organizerId });

    const totalEvents = events.length;
    const upcoming = events.filter((e) => new Date(e.date) > new Date()).length;

    /* ================= TICKETS ================= */
    const tickets = await Ticket.find({ organizer: organizerId });

    const ticketsSold = tickets.length;
    const revenue = tickets.reduce((sum, t) => sum + (t.amountPaid || 0), 0);

    /* ================= WALLET ================= */
    const wallet = await Wallet.findOne({ organizer: organizerId });

    /* ================= EVENT MAP ================= */
    const eventStats = events.map((event) => {
      const sold = tickets.filter(
        (t) => String(t.event) === String(event._id),
      ).length;

      return {
        _id: event._id,
        title: event.title,
        capacity: event.capacity,
        sold,
        status: event.status,
      };
    });

    /* ================= RESPONSE ================= */
    return res.json({
      stats: {
        events: totalEvents,
        ticketsSold,
        revenue,
        upcoming,
        walletBalance: wallet?.balance || 0,
        totalEarnings: wallet?.totalEarnings || 0,
      },
      events: eventStats,
    });
  } catch (error) {
    console.error("DASHBOARD ERROR:", error);
    res.status(500).json({ message: "Dashboard failed" });
  }
};
