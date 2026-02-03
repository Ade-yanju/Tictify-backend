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
    });

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

    // 🔥 Global auto-end
    await Event.updateMany(
      {
        status: "LIVE",
        endDate: { $lte: now },
      },
      { status: "ENDED" },
    );

    // 🔥 Only upcoming + live events
    const events = await Event.find({
      status: "LIVE",
      date: { $gt: now },
      endDate: { $gt: now },
    }).sort("date");

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

    // 🔒 Ownership check
    if (event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // 🔥 Auto-end before deletion check
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
