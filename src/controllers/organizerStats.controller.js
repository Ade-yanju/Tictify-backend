import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import User from "../models/User.js";
import crypto from "crypto";

export const getOrganizerReferrals = async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user.referralCode) { user.referralCode = `ORG-${crypto.randomBytes(3).toString("hex").toUpperCase()}`; await user.save(); }
  const referrals = await User.countDocuments({ referredBy: user.referralCode, role: "organizer" });
  res.json({ referralCode: user.referralCode, referrals });
};

export const getOrganizerEventStats = async (req, res) => {
  try {
    const organizerId = req.user._id;

    // Get all events created by organizer
    const events = await Event.find({ organizer: organizerId });

    const stats = await Promise.all(
      events.map(async (event) => {
        // Tickets sold
        const ticketsSold = await Ticket.countDocuments({
          event: event._id,
        });

        // Tickets scanned
        const ticketsScanned = await Ticket.countDocuments({
          event: event._id,
          scanned: true,
        });

        // Revenue aggregation
        const revenueAgg = await Ticket.aggregate([
          {
            $match: {
              event: event._id,
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amountPaid" },
            },
          },
        ]);

        const revenue = revenueAgg[0]?.total || 0;

        // Total tickets configured
        const totalTickets = event.ticketTypes.reduce(
          (sum, t) => sum + t.quantity,
          0,
        );

        return {
          eventId: event._id,
          title: event.title,
          banner: event.banner,
          date: event.date,
          status: event.status,

          totalTickets,
          ticketsSold,
          ticketsRemaining: totalTickets - ticketsSold,
          ticketsScanned,
          revenue,
        };
      }),
    );

    res.json(stats);
  } catch (err) {
    console.error("ORGANIZER STATS ERROR:", err);
    res.status(500).json({ message: "Failed to load organizer stats" });
  }
};
