import DiscountCode from "../models/DiscountCode.js";
import Event from "../models/Event.js";

const CODE_RE = /^[A-Z0-9_-]{2,20}$/;

/* ORGANIZER: create a code for their event */
export const createDiscount = async (req, res) => {
  try {
    const { eventId, percentOff, maxUses } = req.body;
    const code = String(req.body.code || "").trim().toUpperCase();

    const event = await Event.findById(eventId);
    if (!event || event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (!CODE_RE.test(code)) {
      return res.status(400).json({ message: "Code: 2-20 letters/numbers/dashes" });
    }
    const pct = Number(percentOff);
    if (!Number.isInteger(pct) || pct < 1 || pct > 90) {
      return res.status(400).json({ message: "Percent off must be 1-90" });
    }

    const discount = await DiscountCode.create({
      event: event._id,
      organizer: req.user._id,
      code,
      percentOff: pct,
      maxUses: Math.min(10000, Math.max(1, parseInt(maxUses) || 100)),
    });
    return res.status(201).json(discount);
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ message: "That code already exists for this event" });
    console.error("CREATE DISCOUNT ERROR:", err);
    return res.status(500).json({ message: "Could not create code" });
  }
};

/* ORGANIZER: list + toggle */
export const listDiscounts = async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event || event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    res.json(await DiscountCode.find({ event: event._id }).sort("-createdAt"));
  } catch {
    res.status(500).json({ message: "Failed to load codes" });
  }
};

export const toggleDiscount = async (req, res) => {
  try {
    const d = await DiscountCode.findOne({ _id: req.params.id, organizer: req.user._id });
    if (!d) return res.status(404).json({ message: "Code not found" });
    d.active = !d.active;
    await d.save();
    res.json({ active: d.active });
  } catch {
    res.status(500).json({ message: "Failed" });
  }
};

/* Shared: resolve a live discount (used by quote + initiate) */
export async function resolveDiscount(eventId, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!CODE_RE.test(code)) return null;
  return DiscountCode.findOne({
    event: eventId,
    code,
    active: true,
    $expr: { $lt: ["$uses", "$maxUses"] },
  });
}
