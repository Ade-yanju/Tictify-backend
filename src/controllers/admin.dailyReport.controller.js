import Payment from "../models/Payment.js";
import WalletTransaction from "../models/WalletTransaction.js";
import PageVisit from "../models/PageVisit.js";

const REPORT_TIME_ZONE = "Africa/Lagos";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function lagosDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseDate(value, fallback) {
  if (!DATE_PATTERN.test(String(value || ""))) return fallback;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? fallback
    : value;
}

function dayStart(dateString) {
  return new Date(`${dateString}T00:00:00+01:00`);
}

function emptyDay(date) {
  return {
    date,
    paymentCount: 0,
    installmentPayments: 0,
    ticketsSold: 0,
    ticketOrders: 0,
    installmentTicketOrders: 0,
    grossCollected: 0,
    ticketRevenue: 0,
    platformFees: 0,
    processingFees: 0,
    affiliatePaid: 0,
    affiliatePayments: 0,
    pageVisits: 0,
    uniqueVisitors: 0,
  };
}

const ticketSaleCondition = {
  $or: [
    { $ne: ["$paymentType", "INSTALLMENT"] },
    { $eq: ["$countsAsTicketSale", true] },
  ],
};

export const adminDailyReport = async (req, res) => {
  try {
    const today = lagosDateString();
    const to = parseDate(req.query.to, today);
    const from = parseDate(req.query.from, addDays(to, -29));

    if (from > to) {
      return res.status(400).json({ message: "The start date must be before the end date" });
    }

    const dayCount = Math.round(
      (dayStart(to).getTime() - dayStart(from).getTime()) / 86_400_000,
    ) + 1;
    if (dayCount > 366) {
      return res.status(400).json({ message: "Choose a date range of 366 days or less" });
    }

    const start = dayStart(from);
    const end = dayStart(addDays(to, 1));
    const dayGroup = {
      $dateToString: {
        format: "%Y-%m-%d",
        date: "$createdAt",
        timezone: REPORT_TIME_ZONE,
      },
    };

    const [paymentRows, affiliateRows, pageVisitRows, uniqueIpRows] = await Promise.all([
      Payment.aggregate([
        { $match: { status: "SUCCESS", createdAt: { $gte: start, $lt: end } } },
        {
          $group: {
            _id: dayGroup,
            paymentCount: { $sum: 1 },
            installmentPayments: {
              $sum: { $cond: [{ $eq: ["$paymentType", "INSTALLMENT"] }, 1, 0] },
            },
            ticketsSold: {
              $sum: {
                $cond: [ticketSaleCondition, { $ifNull: ["$quantity", 1] }, 0],
              },
            },
            ticketOrders: { $sum: { $cond: [ticketSaleCondition, 1, 0] } },
            installmentTicketOrders: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$paymentType", "INSTALLMENT"] }, ticketSaleCondition] },
                  1,
                  0,
                ],
              },
            },
            grossCollected: { $sum: { $ifNull: ["$amount", 0] } },
            ticketRevenue: { $sum: { $ifNull: ["$organizerAmount", 0] } },
            platformFees: { $sum: { $ifNull: ["$platformFee", 0] } },
            processingFees: { $sum: { $ifNull: ["$processingFee", 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      WalletTransaction.aggregate([
        {
          $match: {
            type: "CREDIT",
            reference: { $regex: /^AFF-.*-IN$/ },
            createdAt: { $gte: start, $lt: end },
          },
        },
        {
          $group: {
            _id: dayGroup,
            affiliatePaid: { $sum: { $ifNull: ["$amount", 0] } },
            affiliatePayments: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      PageVisit.aggregate([
        { $match: { date: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: "$date",
            pageVisits: { $sum: "$visits" },
            uniqueIps: { $addToSet: "$ip" },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      PageVisit.distinct("ip", { date: { $gte: from, $lte: to } }),
    ]);

    const visitorDetails = await PageVisit.find({ date: { $gte: from, $lte: to } })
      .select("date path ip visits lastVisitedAt")
      .sort({ date: -1, lastVisitedAt: -1 })
      .limit(2000)
      .lean();

    const byDay = new Map();
    for (let date = from; date <= to; date = addDays(date, 1)) {
      byDay.set(date, emptyDay(date));
    }

    for (const row of paymentRows) {
      const day = byDay.get(row._id) || emptyDay(row._id);
      Object.assign(day, {
        paymentCount: Number(row.paymentCount || 0),
        installmentPayments: Number(row.installmentPayments || 0),
        ticketsSold: Number(row.ticketsSold || 0),
        ticketOrders: Number(row.ticketOrders || 0),
        installmentTicketOrders: Number(row.installmentTicketOrders || 0),
        grossCollected: Number(row.grossCollected || 0),
        ticketRevenue: Number(row.ticketRevenue || 0),
        platformFees: Number(row.platformFees || 0),
        processingFees: Number(row.processingFees || 0),
      });
      byDay.set(row._id, day);
    }

    for (const row of affiliateRows) {
      const day = byDay.get(row._id) || emptyDay(row._id);
      day.affiliatePaid = Number(row.affiliatePaid || 0);
      day.affiliatePayments = Number(row.affiliatePayments || 0);
      byDay.set(row._id, day);
    }

    for (const row of pageVisitRows) {
      const day = byDay.get(row._id) || emptyDay(row._id);
      day.pageVisits = Number(row.pageVisits || 0);
      day.uniqueVisitors = Array.isArray(row.uniqueIps) ? row.uniqueIps.length : 0;
      byDay.set(row._id, day);
    }

    const rows = [...byDay.values()];
    const totals = rows.reduce(
      (result, row) => {
        for (const key of Object.keys(result)) result[key] += Number(row[key] || 0);
        return result;
      },
      emptyDay("TOTAL"),
    );
    delete totals.date;
    totals.uniqueVisitors = uniqueIpRows.filter(Boolean).length;

    return res.json({
      timezone: REPORT_TIME_ZONE,
      from,
      to,
      rows,
      totals,
      visitorDetails,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("ADMIN DAILY REPORT ERROR:", error);
    return res.status(500).json({ message: "Unable to load daily financial report" });
  }
};
