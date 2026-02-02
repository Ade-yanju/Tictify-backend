import Event from "../models/Event.js";

/* ================= CREATE EVENT ================= */
export const createEvent = async (req, res) => {
  try {
    const {
      title,
      description,
      location,
      date,
      capacity,
      ticketTypes,
      status,
      banner,
    } = req.body;

    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!banner) {
      return res.status(400).json({ message: "Event banner is required" });
    }

    const event = await Event.create({
      organizer: req.user._id,
      title,
      description,
      location,
      date,
      capacity,
      ticketTypes,
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
  const events = await Event.find({ organizer: req.user._id }).sort(
    "-createdAt",
  );
  res.json(events);
};

/* ================= PUBLIC EVENTS ================= */
export const getPublicEvents = async (_, res) => {
  const now = new Date();

  const events = await Event.find({
    status: "LIVE",
    date: { $gt: now }, // 👈 hide started events
  }).sort("date");

  // 👇 Remove sold-out events
  const availableEvents = events.filter((event) => {
    const sold = event.ticketTypes.reduce(
      (sum, t) => sum + (t.sold || 0),
      0,
    );
    return sold < event.capacity;
  });

  res.json(availableEvents);
};

/* ================= SINGLE EVENT ================= */
export const getEventById = async (req, res) => {
  const event = await Event.findById(req.params.id);
  if (!event) {
    return res.status(404).json({ message: "Event not found" });
  }

  const now = new Date();
  const sold = event.ticketTypes.reduce(
    (sum, t) => sum + (t.sold || 0),
    0,
  );

  res.json({
    ...event.toObject(),
    isSoldOut: sold >= event.capacity,
    isSelling: now < new Date(event.date) && sold < event.capacity,
  });
};

/* ================= STATUS ================= */
export const publishEvent = async (req, res) => {
  await Event.findByIdAndUpdate(req.params.id, { status: "LIVE" });
  res.json({ message: "Event published" });
};

export const endEvent = async (req, res) => {
  await Event.findByIdAndUpdate(req.params.id, { status: "ENDED" });
  res.json({ message: "Event ended" });
};

/* ================= DELETE EVENT ================= */
export const deleteEvent = async (req, res) => {
  const event = await Event.findById(req.params.id);

  if (!event) {
    return res.status(404).json({ message: "Event not found" });
  }

  // 👇 Only owner can delete
  if (event.organizer.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: "Not authorized" });
  }

  // 👇 Only ended events can be deleted
  if (event.status !== "ENDED") {
    return res
      .status(400)
      .json({ message: "Only ended events can be deleted" });
  }

  await event.deleteOne();
  res.json({ message: "Event deleted successfully" });
};
