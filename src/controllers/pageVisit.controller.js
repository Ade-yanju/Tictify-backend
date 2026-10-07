import PageVisit from "../models/PageVisit.js";

function lagosDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export const recordPageVisit = async (req, res) => {
  try {
    const path = String(req.body?.path || "").split("?")[0].trim();

    if (!path.startsWith("/") || path.length > 200) {
      return res.status(400).json({ message: "A valid page path is required" });
    }

    // Express resolves req.ip through the configured trusted proxy. We never
    // accept an IP from the browser body, where it could be falsified.
    const ip = String(req.ip || req.socket?.remoteAddress || "unknown")
      .replace(/^::ffff:/, "")
      .slice(0, 64);
    // Keep one counter per Lagos day, route and IP. This gives admins useful
    // service context without creating one MongoDB document per page view.
    const date = lagosDateString();
    await PageVisit.findOneAndUpdate(
      { date, path, ip },
      {
        $inc: { visits: 1 },
        $set: { lastVisitedAt: new Date() },
        $setOnInsert: { date, path, ip },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    return res.status(204).end();
  } catch (error) {
    console.error("PAGE VISIT ERROR:", error);
    return res.status(204).end();
  }
};
