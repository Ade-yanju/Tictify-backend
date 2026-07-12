// controllers/admin.dashboard.controller.js
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";
import Withdrawal from "../models/Withdrawal.js";
import User from "../models/User.js";

export const adminDashboard = async (req, res) => {
  try {
    const [sales, liveEvents, endedEvents, scheduledEvents, organizers,
           pendingWd, wallets] = await Promise.all([
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
    ]);

    const s = sales[0] || {};

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
    });
  } catch (err) {
    console.error("ADMIN DASHBOARD ERROR:", err);
    res.status(500).json({ message: "Admin dashboard failed" });
  }
};
