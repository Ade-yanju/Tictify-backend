import mongoose from "mongoose";
import User from "../models/User.js";
import Payment from "../models/Payment.js";
import Wallet from "../models/Wallet.js";
import AffiliateSignup from "../models/AffiliateSignup.js";

/* =====================================================
   ADMIN: AFFILIATES — programme overview + per-affiliate
   sales, commissions and membership revenue
===================================================== */
export const getAdminAffiliates = async (req, res) => {
  try {
    const affiliates = await User.find({ role: "affiliate" })
      .select("name email affiliateCode isActive createdAt")
      .sort("-createdAt")
      .lean();

    const codes = affiliates.map((a) => a.affiliateCode).filter(Boolean);
    const userIds = affiliates.map((a) => a._id);

    const [sales, wallets, membership] = await Promise.all([
      /* ONE aggregate for every affiliate's ticket sales */
      Payment.aggregate([
        { $match: { promoter: { $in: codes }, status: "SUCCESS" } },
        {
          $group: {
            _id: "$promoter",
            ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
            salesVolume: { $sum: "$organizerAmount" },
          },
        },
      ]),
      /* ONE query for every affiliate's commission wallet */
      Wallet.find({ organizer: { $in: userIds } }).lean(),
      /* ₦1,000 join fees actually paid */
      AffiliateSignup.aggregate([
        { $match: { status: "PAID" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
    ]);

    const salesBy = Object.fromEntries(sales.map((s) => [s._id, s]));
    const walletBy = Object.fromEntries(
      wallets.map((w) => [w.organizer.toString(), w]),
    );

    const rows = affiliates.map((a) => {
      const s = salesBy[a.affiliateCode] || {};
      const w = walletBy[a._id.toString()] || {};
      return {
        _id: a._id,
        name: a.name,
        email: a.email,
        affiliateCode: a.affiliateCode || null,
        isActive: a.isActive !== false,
        joinedAt: a.createdAt,
        ticketsSold: s.ticketsSold || 0,
        salesVolume: s.salesVolume || 0,
        totalEarned: w.totalEarnings || 0,
        balance: w.balance || 0,
      };
    });

    const stats = {
      totalAffiliates: affiliates.length,
      activeAffiliates: rows.filter((r) => r.isActive).length,
      membershipRevenue: membership[0]?.total || 0,
      ticketsSold: sales.reduce((sum, s) => sum + (s.ticketsSold || 0), 0),
      salesVolume: sales.reduce((sum, s) => sum + (s.salesVolume || 0), 0),
      commissionsEarned: wallets.reduce(
        (sum, w) => sum + (w.totalEarnings || 0),
        0,
      ),
      commissionsUnpaid: wallets.reduce((sum, w) => sum + (w.balance || 0), 0),
    };

    return res.json({ stats, affiliates: rows });
  } catch (err) {
    console.error("ADMIN AFFILIATES ERROR:", err);
    return res.status(500).json({ message: "Failed to load affiliates" });
  }
};

/* =====================================================
   ADMIN: TOGGLE — revoke / reinstate an affiliate
   (flips isActive; login + tracking disabled while off)
===================================================== */
export const toggleAdminAffiliate = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Affiliate not found" });
    }

    const user = await User.findOne({ _id: req.params.id, role: "affiliate" });
    if (!user) return res.status(404).json({ message: "Affiliate not found" });

    user.isActive = !user.isActive;
    await user.save();

    return res.json({ isActive: user.isActive });
  } catch (err) {
    console.error("ADMIN AFFILIATE TOGGLE ERROR:", err);
    return res.status(500).json({ message: "Failed to update affiliate" });
  }
};
