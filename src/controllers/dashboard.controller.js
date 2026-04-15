import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import User from "../models/User.js";

export const organizerDashboard = async (req, res) => {
  try {
    const organizerId = req.user.id;

    /* ================= ORGANIZER PROFILE ================= */
    const organizer =
      await User.findById(organizerId).select("name email avatar");

    /* ================= EVENTS ================= */
    const events = await Event.find({ organizer: organizerId }).sort({
      date: -1,
    });
    const now = new Date();
    const totalEvents = events.length;
    const upcoming = events.filter((e) => new Date(e.date) > now).length;
    const live = events.filter((e) => e.status === "LIVE").length;

    /* ================= TICKETS ================= */
    const tickets = await Ticket.find({ organizer: organizerId });
    const ticketsSold = tickets.length;
    const revenue = tickets.reduce((sum, t) => sum + (t.amountPaid || 0), 0);

    /* ================= WALLET ================= */
    // ✅ upsert — never returns null, auto-creates for new organizers
    const wallet = await Wallet.findOneAndUpdate(
      { organizer: organizerId },
      { $setOnInsert: { organizer: organizerId } },
      { upsert: true, new: true },
    );

    /* ================= EVENT MAP ================= */
    const eventStats = events.map((event) => {
      const eventTickets = tickets.filter(
        (t) => String(t.event) === String(event._id),
      );
      return {
        _id: event._id,
        title: event.title,
        date: event.date,
        capacity: event.capacity,
        sold: eventTickets.length,
        status: event.status,
        revenue: eventTickets.reduce((sum, t) => sum + (t.amountPaid || 0), 0),
      };
    });

    /* ================= RESPONSE ================= */
    return res.json({
      organizer: {
        name: organizer?.name || "Organizer",
        email: organizer?.email || "",
        avatar: organizer?.avatar || null,
      },
      stats: {
        events: totalEvents,
        ticketsSold,
        revenue,
        upcoming,
        live,
        walletBalance: wallet.balance, // ✅ always a number
        totalEarnings: wallet.totalEarnings, // ✅ always a number
      },
      events: eventStats,
    });
  } catch (error) {
    console.error("DASHBOARD ERROR:", error);
    res.status(500).json({ message: "Dashboard failed" });
  }
};
