// controllers/admin.dashboard.controller.js
import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import Wallet from "../models/Wallet.js";
import Withdrawal from "../models/Withdrawal.js";
import User from "../models/User.js";

export const adminDashboard = async (req, res) => {
  try {
    const [events, tickets, wallets, withdrawals, organizers] =
      await Promise.all([
        Event.find(),
        Ticket.find(),
        Wallet.find(),
        Withdrawal.find({ status: "PENDING" }),
        User.find({ role: "organizer" }),
      ]);

    const totalRevenue = tickets.reduce(
      (sum, t) => sum + (t.amountPaid || 0),
      0,
    );

    const platformFees = wallets.reduce(
      (sum, w) => sum + (w.platformFeesPaid || 0),
      0,
    );

    const topOrganizers = wallets
      .sort((a, b) => b.totalEarnings - a.totalEarnings)
      .slice(0, 5);

    res.json({
      stats: {
        totalRevenue,
        platformFees,
        totalTicketsSold: tickets.length,
        totalEvents: events.length,
        totalOrganizers: organizers.length,
        pendingWithdrawals: withdrawals.length,
      },
      topOrganizers,
      pendingWithdrawals: withdrawals,
    });
  } catch (err) {
    console.error("ADMIN DASHBOARD ERROR:", err);
    res.status(500).json({ message: "Admin dashboard failed" });
  }
};
