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

/* ================= PUBLIC ================= */
export const getPublicEvents = async (_, res) => {
  const events = await Event.find({ status: "LIVE" }).sort("date");
  res.json(events);
};

export const getEventById = async (req, res) => {
  const event = await Event.findById(req.params.id);
  if (!event) {
    return res.status(404).json({ message: "Event not found" });
  }
  res.json(event);
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
