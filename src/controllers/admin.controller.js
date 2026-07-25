import User from "../models/User.js";
import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import Payment from "../models/Payment.js";
import { computeAvailability } from "../utils/availability.js";
import { findEventByIdOrSlug } from "../utils/resolveEvent.js";
import { reconcileEventSold } from "../services/soldReconcile.service.js";

export const getAdminOrganizers = async (req, res) => {
  try {
    const organizers = await User.find({ role: "organizer" });

    /* Money + counts are database truth, from SUCCESS Payments and
       quantity-aware — a qty-3 order counts as 3 tickets, not 1. Two
       aggregations feed the whole list instead of 2 queries per
       organizer (the old Ticket.find undercounted every group order and
       drew revenue from a per-document field). */
    const [salesRows, eventRows] = await Promise.all([
      Payment.aggregate([
        { $match: { status: "SUCCESS" } },
        {
          $group: {
            _id: "$organizer",
            ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
            organizerAmount: { $sum: "$organizerAmount" }, // owed to organizer
            grossRevenue: { $sum: "$amount" }, // everything guests paid
            platformFees: { $sum: "$platformFee" }, // Tictify's cut
          },
        },
      ]),
      Event.aggregate([
        { $group: { _id: "$organizer", count: { $sum: 1 } } },
      ]),
    ]);

    const salesByOrg = new Map(salesRows.map((r) => [String(r._id), r]));
    const eventsByOrg = new Map(eventRows.map((r) => [String(r._id), r.count]));

    const data = organizers.map((org) => {
      const s = salesByOrg.get(String(org._id)) || {};
      const organizerAmount = s.organizerAmount || 0;
      return {
        _id: org._id,
        name: org.name,
        email: org.email,
        events: eventsByOrg.get(String(org._id)) || 0,
        ticketsSold: s.ticketsSold || 0,
        /* `revenue` keeps its key for the UI but now means the organizer's
           own take (organizerAmount); gross + fees exposed separately so
           the two are never confused. */
        revenue: organizerAmount,
        organizerAmount,
        grossRevenue: s.grossRevenue || 0,
        platformFees: s.platformFees || 0,
      };
    });

    // sort by the organizer's take DESC
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

    /* ONE aggregation for the whole page: quantity-aware sold per event
       from SUCCESS Payments — the same authoritative source availability.js
       and the reconcile sweep use. A qty-3 order counts as 3. This replaces
       the old per-event Ticket.countDocuments, which counted Ticket
       DOCUMENTS (one per order) and so undercounted every group order and
       disagreed with availability.totalSold on the same row. */
    const soldRows = await Payment.aggregate([
      { $match: { status: "SUCCESS" } },
      {
        $group: {
          _id: "$event",
          ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
        },
      },
    ]);
    const soldByEvent = new Map(
      soldRows.map((r) => [String(r._id), r.ticketsSold]),
    );

    const data = await Promise.all(
      events.map(async (e) => {
        /* Low-traffic admin page: recount against SUCCESS payments so
           the figures below are database truth, not a drifted counter.
           A recount failure degrades to the stored counters rather
           than failing the whole listing. */
        await reconcileEventSold(e).catch((err) =>
          console.error("ADMIN RECONCILE:", err?.message || err),
        );

        /* After the reconcile above, tier counters equal the SUCCESS
           payment sums, so this equals computeAvailability(e).totalSold. */
        const ticketsSold = soldByEvent.get(String(e._id)) || 0;

        return {
          _id: e._id,
          slug: e.slug || null,
          title: e.title,
          date: e.date,
          capacity: e.capacity,
          ticketsSold,
          status: e.status,
          organizerName: e.organizer?.name || "Unknown",
          organizerEmail: e.organizer?.email || "",
          /* Quantity-aware sold above (SUCCESS Payments). availability
             mirrors the checkout guards on the event's own tier counters;
             both now derive from the same source and agree. */
          availability: computeAvailability(e),
        };
      }),
    );

    res.json(data);
  } catch (err) {
    console.error("ADMIN EVENTS ERROR:", err);
    res.status(500).json({ message: "Failed to load events" });
  }
};
/* =====================================================
   ADMIN: FORCE A RECOUNT OF ONE EVENT
   Runs the same Payment-derived reconciliation the 15-minute
   sweep runs, but on demand — so an admin who suspects a
   drifted counter doesn't have to wait for the next tick.
===================================================== */
export const adminRecountEvent = async (req, res) => {
  try {
    const event = await findEventByIdOrSlug(req.params.id);
    if (!event) return res.status(404).json({ message: "Event not found" });

    const { changed, drifts } = await reconcileEventSold(event);

    return res.json({
      changed,
      drifts,
      availability: computeAvailability(event),
    });
  } catch (err) {
    console.error("ADMIN RECOUNT ERROR:", err);
    return res.status(500).json({ message: "Recount failed" });
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

  /* Quantity-aware, from SUCCESS Payments (money truth) — not one row
     per Ticket document. Shape preserved: { event, sold, revenue } and
     { organizer, sold, revenue }. */
  const topEvents = await Payment.aggregate([
    { $match: { status: "SUCCESS" } },
    {
      $group: {
        _id: "$event",
        revenue: { $sum: "$amount" },
        sold: { $sum: { $ifNull: ["$quantity", 1] } },
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

  const topOrganizers = await Payment.aggregate([
    { $match: { status: "SUCCESS" } },
    {
      $group: {
        _id: "$organizer",
        revenue: { $sum: "$amount" },
        sold: { $sum: { $ifNull: ["$quantity", 1] } },
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
