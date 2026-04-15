import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import User from "../models/User.js"; // ← add this

export const organizerDashboard = async (req, res) => {
  try {
    const organizerId = req.user.id;

    /* ================= ORGANIZER PROFILE ================= */
    const organizer = await User.findById(organizerId).select("name email avatar");

    /* ================= EVENTS ================= */
    const events = await Event.find({ organizer: organizerId }).sort({ date: -1 });
    const totalEvents = events.length;
    const now = new Date();
    const upcoming = events.filter((e) => new Date(e.date) > now).length;
    const live = events.filter((e) => e.status === "LIVE").length;

    /* ================= TICKETS ================= */
    const tickets = await Ticket.find({ organizer: organizerId });
    const ticketsSold = tickets.length;
    const revenue = tickets.reduce((sum, t) => sum + (t.amountPaid || 0), 0);

    /* ================= WALLET ================= */
    const wallet = await Wallet.findOne({ organizer: organizerId });

    /* ================= EVENT MAP ================= */
    const eventStats = events.map((event) => {
      const sold = tickets.filter(
        (t) => String(t.event) === String(event._id)
      ).length;
      return {
        _id: event._id,
        title: event.title,
        date: event.date,
        capacity: event.capacity,
        sold,
        status: event.status,
        revenue: tickets
          .filter((t) => String(t.event) === String(event._id))
          .reduce((sum, t) => sum + (t.amountPaid || 0), 0),
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
