import Event from "../models/Event.js";

/* ================= CREATE EVENT ================= */

export const createEvent = async (req, res) => {
  try {
    const {
      title,
      description,
      location,
      date, // start time
      endDate, // end time
      capacity,
      ticketTypes,
      status = "DRAFT",
      banner,
    } = req.body;

    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!banner) {
      return res.status(400).json({ message: "Event banner is required" });
    }

    if (!date || !endDate) {
      return res
        .status(400)
        .json({ message: "Event start and end time are required" });
    }

    if (new Date(endDate) <= new Date(date)) {
      return res
        .status(400)
        .json({ message: "Event end time must be after start time" });
    }

    const event = await Event.create({
      organizer: req.user._id,
      title,
      description,
      location,
      date: new Date(date),
      endDate: new Date(endDate),
      capacity,
      ticketTypes: ticketTypes.map((t) => ({
        ...t,
        sold: 0,
      })),
      status,
      banner,
      category: req.body.category || "Other",
      city: String(req.body.city || "").trim(),
    });

    // 🔔 New LIVE event → push alert to subscribed guests (fire-and-forget)
    if (event.status === "LIVE") {
      import("../services/push.service.js")
        .then(({ notifyNewEvent }) => notifyNewEvent(event))
        .catch((err) => console.error("Push notify failed:", err.message));
    }

    res.status(201).json(event);
  } catch (err) {
    console.error("CREATE EVENT ERROR:", err);
    res.status(500).json({ message: "Failed to create event" });
  }
};

/* ================= ORGANIZER EVENTS ================= */
export const getOrganizerEvents = async (req, res) => {
  try {
    const now = new Date();

    // 🔥 Auto-end expired events for THIS organizer
    await Event.updateMany(
      {
        organizer: req.user._id,
        status: "LIVE",
        endDate: { $lte: now },
      },
      { status: "ENDED" },
    );

    const events = await Event.find({
      organizer: req.user._id,
    }).sort("-createdAt");

    res.json(events);
  } catch (err) {
    console.error("GET ORGANIZER EVENTS ERROR:", err);
    res.status(500).json({ message: "Unable to load events" });
  }
};

/* ================= PUBLIC EVENTS ================= */
export const getPublicEvents = async (_, res) => {
  try {
    const now = new Date();

    /**
     * 1️⃣ FORCE DATABASE CONSISTENCY
     * Any event past endDate is ENDED — permanently
     */
    await Event.updateMany(
      {
        endDate: { $lte: now },
        status: { $ne: "ENDED" },
      },
      { status: "ENDED" },
    );

    /**
     * 2️⃣ ONLY FETCH VALID EVENTS
     * ❌ ENDED EVENTS NEVER COME BACK
     */
    const events = await Event.find({
      status: "LIVE",
      endDate: { $gt: now },
    }).sort("date");

    /**
     * 3️⃣ REMOVE SOLD-OUT EVENTS
     */
    const availableEvents = events.filter((event) => {
      const sold = event.ticketTypes.reduce((sum, t) => sum + (t.sold || 0), 0);
      return sold < event.capacity;
    });

    res.json(availableEvents);
  } catch (err) {
    console.error("GET PUBLIC EVENTS ERROR:", err);
    res.status(500).json({ message: "Unable to load events" });
  }
};

/* ================= SINGLE EVENT ================= */
export const getEventById = async (req, res) => {
  try {
    const now = new Date();

    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    // 🔥 Auto-end if expired
    if (event.status === "LIVE" && now >= event.endDate) {
      event.status = "ENDED";
      await event.save();
    }

    const sold = event.ticketTypes.reduce((sum, t) => sum + (t.sold || 0), 0);

    res.json({
      ...event.toObject(),
      isSoldOut: sold >= event.capacity,
      isSelling:
        event.status === "LIVE" && now < event.endDate && sold < event.capacity,
    });
  } catch (err) {
    console.error("GET EVENT ERROR:", err);
    res.status(500).json({ message: "Unable to load event" });
  }
};

/* ================= STATUS ================= */
export const publishEvent = async (req, res) => {
  try {
    const now = new Date();

    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    // ❌ Cannot publish expired event
    if (now >= event.endDate) {
      event.status = "ENDED";
      await event.save();
      return res
        .status(400)
        .json({ message: "Cannot publish an event that has ended" });
    }

    event.status = "LIVE";
    await event.save();

    res.json({ message: "Event published" });
  } catch (err) {
    console.error("PUBLISH EVENT ERROR:", err);
    res.status(500).json({ message: "Unable to publish event" });
  }
};

export const endEvent = async (req, res) => {
  await Event.findByIdAndUpdate(req.params.id, { status: "ENDED" });
  res.json({ message: "Event ended" });
};

/* ================= DELETE EVENT ================= */
export const deleteEvent = async (req, res) => {
  try {
    const now = new Date();

    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    // Owner check
    if (event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // 🔥 AUTO-END IF TIME HAS PASSED
    if (event.status === "LIVE" && now >= event.endDate) {
      event.status = "ENDED";
      await event.save();
    }

    if (event.status !== "ENDED") {
      return res
        .status(400)
        .json({ message: "Only ended events can be deleted" });
    }

    await event.deleteOne();
    res.json({ message: "Event deleted successfully" });
  } catch (err) {
    console.error("DELETE EVENT ERROR:", err);
    res.status(500).json({ message: "Unable to delete event" });
  }
};

/* =====================================================
   ADMIN: CANCEL EVENT
   - blocks further sales (status guard) and gate scans
   - claws back this event's revenue from the organizer's
     wallet (up to their current balance) so refunds can
     be honoured; every kobo is audit-logged
===================================================== */
export const adminCancelEvent = async (req, res) => {
  try {
    const event = await Event.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ["LIVE", "DRAFT"] } },
      {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: String(req.body?.reason || "").slice(0, 300),
      },
      { new: true },
    );
    if (!event) {
      return res
        .status(400)
        .json({ message: "Event not found or already ended/cancelled" });
    }

    const [{ default: Payment }, { default: Wallet }, { default: WalletTransaction }] =
      await Promise.all([
        import("../models/Payment.js"),
        import("../models/Wallet.js"),
        import("../models/WalletTransaction.js"),
      ]);

    /* Revenue this event put into the organizer's wallet */
    const agg = await Payment.aggregate([
      { $match: { event: event._id, status: "SUCCESS" } },
      { $group: { _id: null, revenue: { $sum: "$organizerAmount" } } },
    ]);
    const revenue = agg[0]?.revenue || 0;

    let frozen = 0;
    if (revenue > 0) {
      /* Atomic: never push the wallet negative — claw back what's there */
      const wallet = await Wallet.findOne({ organizer: event.organizer });
      frozen = Math.min(wallet?.balance || 0, revenue);
      if (frozen > 0) {
        await Wallet.updateOne(
          { organizer: event.organizer, balance: { $gte: frozen } },
          { $inc: { balance: -frozen } },
        );
        await WalletTransaction.create({
          organizer: event.organizer,
          type: "DEBIT",
          amount: frozen,
          reference: `CANCEL-${event._id}`,
          description: `Event "${event.title}" cancelled — ₦${frozen.toLocaleString()} held for guest refunds`,
        });
      }
    }

    return res.json({
      message: `Event cancelled. ₦${frozen.toLocaleString()} of ₦${revenue.toLocaleString()} revenue held for refunds.`,
      revenue,
      frozen,
    });
  } catch (err) {
    console.error("CANCEL EVENT ERROR:", err);
    return res.status(500).json({ message: "Cancellation failed" });
  }
};
