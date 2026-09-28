import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";
import User from "../models/User.js";
import Withdrawal from "../models/Withdrawal.js";
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
      $or: [
        { salesOrganizer: organizerId },
        { salesOrganizer: { $exists: false }, organizer: organizerId },
        { salesOrganizer: null, organizer: organizerId },
      ],
      status: "SUCCESS",
      countsAsTicketSale: { $ne: false },
    };

    const [organizer, events, wallet, salesByEvent, salesByDay, salesByType, recentPayments, recentWithdrawals] =
      await Promise.all([
        User.findById(organizerId).select("name email avatar whatsapp").lean(),
        Event.find({ $or: [
          { organizer: organizerId },
          { coHosts: { $elemMatch: { organizer: organizerId, status: "ACCEPTED" } } },
        ] }).sort({ date: -1 }).lean(),
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
        Payment.find({
          $or: [
            { salesOrganizer: organizerId },
            { salesOrganizer: { $exists: false }, organizer: organizerId },
            { salesOrganizer: null, organizer: organizerId },
          ],
          status: { $in: ["SUCCESS", "REFUNDED", "FAILED", "PENDING"] },
        })
          .select("event eventTitle ticketType amount platformFee processingFee organizerAmount quantity reference status paymentType installmentAmount installmentNumber countsAsTicketSale createdAt")
          .sort({ createdAt: -1 })
          .limit(80)
          .lean(),
        Withdrawal.find({ organizer: organizerId })
          .select("amount transferFee netAmount status bankDetails.bankName bankDetails.accountNumber createdAt updatedAt paidAt")
          .sort({ createdAt: -1 })
          .limit(80)
          .lean(),
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

    const transactionRows = [
      ...recentPayments.map((payment) => {
        const isInstallment = payment.paymentType === "INSTALLMENT" && payment.countsAsTicketSale === false;
        const organizerAmount = Number(payment.organizerAmount || 0);
        const amount = isInstallment
          ? Number(payment.installmentAmount ?? Math.max(0, Number(payment.amount || 0) - Number(payment.processingFee || 0)))
          : organizerAmount;
        return {
          id: "payment:" + String(payment._id),
          type: isInstallment ? "INSTALLMENT" : "TICKET_SALE",
          title: payment.eventTitle || (isInstallment ? "Installment payment" : "Ticket sale"),
          status: payment.status,
          direction: isInstallment ? "INFO" : "CREDIT",
          amount,
          settledAmount: organizerAmount,
          grossAmount: Number(payment.amount || 0),
          platformFee: Number(payment.platformFee || 0),
          processingFee: Number(payment.processingFee || 0),
          eventTitle: payment.eventTitle || "",
          ticketType: payment.ticketType || "",
          quantity: Number(payment.quantity || 1),
          installmentNumber: payment.installmentNumber || null,
          reference: payment.reference,
          createdAt: payment.createdAt,
        };
      }),
      ...recentPayments
        .filter((payment) => Number(payment.platformFee || 0) > 0 || Number(payment.processingFee || 0) > 0)
        .map((payment) => ({
          id: "fee:" + String(payment._id),
          type: "FEE",
          title: payment.paymentType === "INSTALLMENT" ? "Installment payment fees" : "Ticket payment fees",
          status: payment.status,
          direction: "FEE",
          amount: Number(payment.platformFee || 0) + Number(payment.processingFee || 0),
          platformFee: Number(payment.platformFee || 0),
          processingFee: Number(payment.processingFee || 0),
          eventTitle: payment.eventTitle || "",
          reference: payment.reference,
          createdAt: payment.createdAt,
        })),
      ...recentWithdrawals.map((withdrawal) => {
        const status = withdrawal.status === "APPROVED" ? "PROCESSING" : withdrawal.status === "PAID" ? "SUCCESS" : withdrawal.status;
        const returned = ["FAILED", "REJECTED", "EXPIRED"].includes(status);
        const bank = withdrawal.bankDetails || {};
        return {
          id: "withdrawal:" + String(withdrawal._id),
          type: "WITHDRAWAL",
          title: returned ? "Withdrawal returned" : "Withdrawal to bank",
          status,
          direction: returned ? "RETURNED" : "DEBIT",
          amount: Number(withdrawal.amount || 0),
          netAmount: Number(withdrawal.netAmount ?? withdrawal.amount ?? 0),
          transferFee: Number(withdrawal.transferFee || 0),
          bankName: bank.bankName || "Bank account",
          accountLast4: bank.accountNumber ? String(bank.accountNumber).slice(-4) : "",
          createdAt: withdrawal.createdAt,
        };
      }),
    ]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 100);
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
      transactions: transactionRows,
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
