// controllers/admin.dashboard.controller.js
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";
import Withdrawal from "../models/Withdrawal.js";
import User from "../models/User.js";
import { computeAvailability } from "../utils/availability.js";

/* Show an admin who's buying without exposing a full guest address:
   first char + *** + domain, e.g. "john@gmail.com" → "j***@gmail.com". */
function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return "***";
  const [local, domain] = email.split("@");
  return `${local.charAt(0) || ""}***@${domain}`;
}

export const adminDashboard = async (req, res) => {
  try {
    const [sales, liveEvents, endedEvents, scheduledEvents, organizers,
           pendingWd, wallets, salesByEventRows, recentPayments] = await Promise.all([
      /* Money truth lives on successful Payments — includes quantity
         and the REAL platformFee charged at checkout */
      Payment.aggregate([
        { $match: { status: "SUCCESS" } },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$amount" },            // everything guests paid
            platformFees: { $sum: "$platformFee" },  // Tictify's actual cut
            ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
          },
        },
      ]),
      Event.countDocuments({ status: "LIVE" }),
      Event.countDocuments({ status: "ENDED" }),
      Event.countDocuments({ status: "DRAFT" }),
      User.countDocuments({ role: "organizer" }),
      Withdrawal.aggregate([
        { $match: { status: "PENDING" } },
        { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Wallet.find().sort("-totalEarnings").limit(5),

      /* Per-event sales breakdown — one aggregation over SUCCESS Payments
         grouped by event, joined to the event (title/slug/status/capacity/
         ticketTypes) and its organizer. Quantity-aware so group orders
         count fully. Only events with ≥1 SUCCESS payment appear. */
      Payment.aggregate([
        { $match: { status: "SUCCESS" } },
        {
          $group: {
            _id: "$event",
            ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
            revenue: { $sum: "$amount" }, // gross — everything guests paid
            platformFees: { $sum: "$platformFee" }, // Tictify's cut
            /* carried so orphaned sales (deleted event) stay attributed */
            organizer: { $first: "$organizer" },
            eventTitle: { $first: "$eventTitle" },
          },
        },
        {
          $lookup: {
            from: "events",
            localField: "_id",
            foreignField: "_id",
            as: "event",
          },
        },
        /* preserveNull: a sale whose event was DELETED must NOT be
           dropped — otherwise the per-event rows no longer add up to the
           revenue total. It stays as an "unknown/deleted event" row. */
        { $unwind: { path: "$event", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "users",
            localField: "organizer", // the PAYMENT's organizer, survives deletion
            foreignField: "_id",
            as: "organizer",
          },
        },
        { $unwind: { path: "$organizer", preserveNullAndEmptyArrays: true } },
        { $sort: { revenue: -1 } },
      ]),

      /* Recent activity feed — last 8 SUCCESS payments, newest first. */
      Payment.find({ status: "SUCCESS" })
        .sort("-createdAt")
        .limit(8)
        .populate("event", "title")
        .lean(),
    ]);

    const s = sales[0] || {};

    /* Reuse computeAvailability so `remaining` matches availability.js
       exactly (event-level remaining, capped by both capacity and the
       tiers). capacity comes from the same computation. */
    const salesByEvent = (salesByEventRows || []).map((r) => {
      /* r.event is null when the event was deleted after the sale.
         Fall back to the title snapshotted on the payment so the row
         is still named and the totals reconcile. */
      const deleted = !r.event;
      const availability = deleted ? null : computeAvailability(r.event);
      const capacity = availability?.capacity ?? r.event?.capacity ?? null;
      const remaining =
        availability?.remaining != null
          ? availability.remaining
          : capacity != null
          ? Math.max(0, capacity - (r.ticketsSold || 0))
          : null;
      return {
        _id: r._id,
        title:
          r.event?.title ||
          (r.eventTitle ? `${r.eventTitle} (deleted)` : "Deleted event"),
        slug: r.event?.slug || null,
        status: r.event?.status || "DELETED",
        organizerName: r.organizer?.name || "Unknown",
        ticketsSold: r.ticketsSold || 0,
        revenue: r.revenue || 0, // gross
        platformFees: r.platformFees || 0,
        capacity,
        remaining,
      };
    });

    const recentSales = (recentPayments || []).map((p) => ({
      reference: p.reference,
      eventTitle: p.event?.title || p.eventTitle || "Deleted event",
      ticketType: p.ticketType || "",
      quantity: p.quantity || 1,
      amount: p.amount || 0,
      buyerEmailMasked: maskEmail(p.email),
      createdAt: p.createdAt,
    }));

    res.json({
      stats: {
        /* keys the dashboard UI reads */
        revenue: s.revenue || 0,
        platformFees: s.platformFees || 0,
        ticketsSold: s.ticketsSold || 0,
        events: liveEvents,
        organizers,
        pendingAmount: pendingWd[0]?.amount || 0,
        liveEvents,
        endedEvents,
        scheduledEvents,
        /* legacy keys kept for any other consumers */
        totalRevenue: s.revenue || 0,
        totalTicketsSold: s.ticketsSold || 0,
        totalEvents: liveEvents + endedEvents + scheduledEvents,
        totalOrganizers: organizers,
        pendingWithdrawals: pendingWd[0]?.count || 0,
      },
      topOrganizers: wallets,
      salesByEvent, // per-event breakdown (qty-aware, SUCCESS Payments)
      recentSales, // last 8 SUCCESS payments, newest first, email masked
    });
  } catch (err) {
    console.error("ADMIN DASHBOARD ERROR:", err);
    res.status(500).json({ message: "Admin dashboard failed" });
  }
};
