// controllers/admin.analytics.controller.js
import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";

export const adminAnalytics = async (req, res) => {
  try {
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

    const eventsByMonth = await Event.aggregate([
      {
        $group: {
          _id: { $month: "$createdAt" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    /* ================= NEW: PLATFORM FEES ================= */
    const platformFeesByMonth = await Ticket.aggregate([
      {
        $group: {
          _id: { $month: "$createdAt" },
          total: {
            $sum: {
              $add: [{ $multiply: ["$amountPaid", 0.03] }, 80],
            },
          },
        },
      },
      {
        $project: {
          _id: 1,
          total: { $round: ["$total", 0] },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      revenueByMonth,
      ticketsByMonth,
      eventsByMonth,
      platformFeesByMonth, // ✅ NEW (non-breaking)
    });
  } catch (err) {
    console.error("ADMIN ANALYTICS ERROR:", err);
    res.status(500).json({ message: "Analytics failed" });
  }
};

/* =====================================================
   💰 PLATFORM FINANCE — every naira on the platform
===================================================== */
export const adminFinance = async (req, res) => {
  try {
    const [{ default: Payment }, { default: WalletTransaction }, { default: Wallet },
           { default: Withdrawal }, { default: AffiliateSignup }] = await Promise.all([
      import("../models/Payment.js"),
      import("../models/WalletTransaction.js"),
      import("../models/Wallet.js"),
      import("../models/Withdrawal.js"),
      import("../models/AffiliateSignup.js"),
    ]);

    const [sales, refunded, affCommission, ambCommission, joinFees, wdFees, liabilities] =
      await Promise.all([
        Payment.aggregate([
          { $match: { status: "SUCCESS" } },
          { $group: {
              _id: null,
              grossVolume: { $sum: "$amount" },
              ticketRevenue: { $sum: "$organizerAmount" },
              platformFees: { $sum: "$platformFee" },
              processingFees: { $sum: "$processingFee" },
              discountsGiven: { $sum: "$discountAmount" },
              ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
              orders: { $sum: 1 },
          } },
        ]),
        Payment.aggregate([
          { $match: { status: "REFUNDED" } },
          { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        WalletTransaction.aggregate([
          { $match: { type: "CREDIT", reference: /^AFF-.*-IN$/ } },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        WalletTransaction.aggregate([
          { $match: { type: "CREDIT", reference: /^COMM-/ } },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        AffiliateSignup.aggregate([
          { $match: { status: "PAID" } },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        Withdrawal.aggregate([
          { $match: { status: { $in: ["PAID", "APPROVED"] } } },
          { $group: { _id: null, fees: { $sum: "$transferFee" }, paidOut: { $sum: "$netAmount" }, count: { $sum: 1 } } },
        ]),
        Wallet.aggregate([
          { $group: { _id: null, total: { $sum: "$balance" } } },
        ]),
      ]);

    const s = sales[0] || {};
    const platformFees = s.platformFees || 0;
    const memberships = joinFees[0]?.total || 0;
    const withdrawalFeeMargin = wdFees[0]?.fees || 0;
    const ambPaid = ambCommission[0]?.total || 0;

    return res.json({
      sales: {
        grossVolume: s.grossVolume || 0,       // everything guests paid
        ticketRevenue: s.ticketRevenue || 0,   // organizers' share
        platformFees,                          // Tictify's % on ticket sales
        processingFees: s.processingFees || 0, // Paystack's cut (guest-paid)
        discountsGiven: s.discountsGiven || 0,
        ticketsSold: s.ticketsSold || 0,
        orders: s.orders || 0,
      },
      commissions: {
        affiliatePaid: affCommission[0]?.total || 0,   // organizer-funded
        affiliatePayments: affCommission[0]?.count || 0,
        ambassadorPaid: ambPaid,                        // platform-funded
        ambassadorPayments: ambCommission[0]?.count || 0,
      },
      memberships: {
        affiliateJoinRevenue: memberships,
        affiliatesJoined: joinFees[0]?.count || 0,
      },
      withdrawals: {
        paidOut: wdFees[0]?.paidOut || 0,
        transferFeeMargin: withdrawalFeeMargin,
        processed: wdFees[0]?.count || 0,
      },
      refunds: {
        amount: refunded[0]?.amount || 0,
        count: refunded[0]?.count || 0,
      },
      walletLiabilities: liabilities[0]?.total || 0,   // owed to organizers/partners
      /* What Tictify actually keeps */
      netPlatformRevenue:
        platformFees + memberships + withdrawalFeeMargin - ambPaid,
    });
  } catch (err) {
    console.error("ADMIN FINANCE ERROR:", err);
    return res.status(500).json({ message: "Failed to load finance data" });
  }
};
