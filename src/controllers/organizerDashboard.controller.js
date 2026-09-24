import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";
import User from "../models/User.js";
import mongoose from "mongoose";

const TIME_ZONE = "Africa/Lagos";

function dayKey(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dayLabel(date) {
  return new Intl.DateTimeFormat("en-NG", {
    timeZone: TIME_ZONE,
    weekday: "short",
  }).format(date);
}

export const organizerDashboard = async (req, res) => {
  try {
    const organizerId = new mongoose.Types.ObjectId(req.user.id);
    const now = new Date();
    const trendStart = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);

    const saleMatch = {
      organizer: organizerId,
      status: "SUCCESS",
      countsAsTicketSale: { $ne: false },
    };

    const [organizer, events, wallet, salesByEvent, salesByDay, salesByType] =
      await Promise.all([
        User.findById(organizerId).select("name email avatar whatsapp").lean(),
        Event.find({ organizer: organizerId }).sort({ date: -1 }).lean(),
        Wallet.findOneAndUpdate(
          { organizer: organizerId },
          { $setOnInsert: { organizer: organizerId, balance: 0, totalEarnings: 0 } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        ).lean(),
        Payment.aggregate([
          { $match: saleMatch },
          {
            $group: {
              _id: "$event",
              sold: { $sum: { $ifNull: ["$quantity", 1] } },
              revenue: { $sum: { $ifNull: ["$organizerAmount", 0] } },
            },
          },
        ]),
        Payment.aggregate([
          {
            $match: {
              ...saleMatch,
              createdAt: { $gte: trendStart },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: TIME_ZONE,
                },
              },
              sold: { $sum: { $ifNull: ["$quantity", 1] } },
            },
          },
          { $sort: { _id: 1 } },
        ]),
        Payment.aggregate([
          { $match: saleMatch },
          {
            $group: {
              _id: { $ifNull: ["$ticketType", "Other"] },
              sold: { $sum: { $ifNull: ["$quantity", 1] } },
            },
          },
          { $sort: { sold: -1, _id: 1 } },
        ]),
      ]);

    const byEvent = Object.fromEntries(
      salesByEvent.map((sale) => [String(sale._id), sale]),
    );

    const stats = salesByEvent.reduce(
      (result, sale) => ({
        ticketsSold: result.ticketsSold + Number(sale.sold || 0),
        revenue: result.revenue + Number(sale.revenue || 0),
      }),
      { ticketsSold: 0, revenue: 0 },
    );

    const eventStats = events.map((event) => {
      const sale = byEvent[String(event._id)] || { sold: 0, revenue: 0 };
      return {
        _id: event._id,
        title: event.title,
        date: event.date,
        capacity: Number(event.capacity || 0),
        sold: Number(sale.sold || 0),
        ticketsSold: Number(sale.sold || 0),
        status: event.status,
        revenue: Number(sale.revenue || 0),
      };
    });

    const salesByDayMap = Object.fromEntries(
      salesByDay.map((sale) => [sale._id, Number(sale.sold || 0)]),
    );
    const salesTrend = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(now.getTime() - (6 - index) * 24 * 60 * 60 * 1000);
      const key = dayKey(date);
      return { label: dayLabel(date), date: key, sold: salesByDayMap[key] || 0 };
    });

    const ticketMix = salesByType.map((sale) => ({
      name: String(sale._id || "Other"),
      sold: Number(sale.sold || 0),
    }));

    const totalCapacity = events.reduce(
      (sum, event) => sum + Number(event.capacity || 0),
      0,
    );
    const reservedTickets = events.reduce(
      (sum, event) => sum + Number(event.reservedTickets || 0),
      0,
    );

    let upcoming = 0;
    let live = 0;
    events.forEach((event) => {
      if (new Date(event.date) > now) upcoming += 1;
      if (event.status === "LIVE") live += 1;
    });

    return res.json({
      organizer: {
        name: organizer?.name || "Organizer",
        email: organizer?.email || "",
        avatar: organizer?.avatar || null,
        whatsapp: organizer?.whatsapp || null,
      },
      stats: {
        events: events.length,
        ticketsSold: stats.ticketsSold,
        revenue: stats.revenue,
        upcoming,
        live,
        walletBalance: wallet?.balance || 0,
        totalEarnings: wallet?.totalEarnings || 0,
      },
      events: eventStats,
      salesTrend,
      ticketMix,
      capacity: {
        total: totalCapacity,
        sold: stats.ticketsSold,
        reserved: reservedTickets,
        available: Math.max(0, totalCapacity - stats.ticketsSold - reservedTickets),
      },
    });
  } catch (error) {
    console.error("DASHBOARD ERROR:", error);
    return res.status(500).json({ message: "Failed to load unique organizer data." });
  }
};
