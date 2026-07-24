import User from "../models/User.js";
import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import { computeAvailability } from "../utils/availability.js";
import { findEventByIdOrSlug } from "../utils/resolveEvent.js";
import { reconcileEventSold } from "../services/soldReconcile.service.js";

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

        /* Low-traffic admin page: recount against SUCCESS payments so
           the figures below are database truth, not a drifted counter.
           A recount failure degrades to the stored counters rather
           than failing the whole listing. */
        await reconcileEventSold(e).catch((err) =>
          console.error("ADMIN RECONCILE:", err?.message || err),
        );

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
          /* ticketsSold above counts Ticket DOCUMENTS (one per order).
             availability mirrors the checkout guards on the event's own
             tier counters — kept side by side, neither replaces the other. */
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
