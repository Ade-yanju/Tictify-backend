import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";
import User from "../models/User.js";
import mongoose from "mongoose";

export const organizerDashboard = async (req, res) => {
  try {
    const organizerId = new mongoose.Types.ObjectId(req.user.id);
    const now = new Date();

    const [organizer, events, wallet, salesByEvent] = await Promise.all([
      User.findById(organizerId).select("name email avatar").lean(),
      Event.find({ organizer: organizerId }).sort({ date: -1 }).lean(),
      Wallet.findOneAndUpdate(
        { organizer: organizerId },
        { $setOnInsert: { organizer: organizerId, balance: 0, totalEarnings: 0 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean(),
      /* Money truth: successful Payments — quantity-aware, matches
         exactly what the wallet was credited (organizerAmount) */
      Payment.aggregate([
        { $match: { organizer: organizerId, status: "SUCCESS" } },
        {
          $group: {
            _id: "$event",
            sold: { $sum: { $ifNull: ["$quantity", 1] } },
            revenue: { $sum: "$organizerAmount" },
          },
        },
      ]),
    ]);

    const byEvent = Object.fromEntries(
      salesByEvent.map((s) => [String(s._id), s]),
    );

    let ticketsSold = 0;
    let totalRevenue = 0;
    salesByEvent.forEach((s) => {
      ticketsSold += s.sold;
      totalRevenue += s.revenue;
    });

    let upcoming = 0;
    let live = 0;
    events.forEach((e) => {
      if (new Date(e.date) > now) upcoming++;
      if (e.status === "LIVE") live++;
    });

    const eventStats = events.map((event) => {
      const s = byEvent[String(event._id)] || { sold: 0, revenue: 0 };
      return {
        _id: event._id,
        title: event.title,
        date: event.date,
        capacity: event.capacity,
        sold: s.sold,
        status: event.status,
        revenue: s.revenue,
      };
    });

    return res.json({
      organizer: {
        name: organizer?.name || "Organizer",
        email: organizer?.email || "",
        avatar: organizer?.avatar || null,
      },
      stats: {
        events: events.length,
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
