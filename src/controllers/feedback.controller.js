import Feedback from "../models/Feedback.js";

export async function submitFeedback(req, res) {
  const message = String(req.body.message || "").trim();
  if (message.length < 10) return res.status(400).json({ message: "Please enter at least 10 characters." });
  const name = String(req.user?.name || req.body.name || "").trim();
  const email = String(req.user?.email || req.body.email || "").trim().toLowerCase();
  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: "Name and a valid email are required." });

  const submissionKey = String(req.body.submissionKey || "").trim();
  if (submissionKey) {
    const existing = await Feedback.findOne({ submissionKey }).select("+submissionKey").lean();
    if (existing) return res.status(200).json({ feedback: existing, duplicate: true });
  }

  // Also protect older clients and a fresh-page resubmission: an exact copy
  // from the same email within ten minutes is the same feedback, even when it
  // has a newly generated browser key.
  const recent = await Feedback.findOne({
    email,
    message,
    category: req.body.category || "GENERAL",
    createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
  }).sort("-createdAt").lean();
  if (recent) return res.status(200).json({ feedback: recent, duplicate: true });

  try {
    const feedback = await Feedback.create({
      user: req.user?._id,
      role: req.user?.role || "guest",
      name,
      email,
      category: req.body.category,
      rating: req.body.rating,
      message,
      ...(submissionKey ? { submissionKey } : {}),
    });
    return res.status(201).json({ feedback });
  } catch (error) {
    // Two identical requests can pass the read check at the same time. The
    // unique index makes one win; the other returns that same record.
    if (error?.code === 11000 && submissionKey) {
      const existing = await Feedback.findOne({ submissionKey }).select("+submissionKey").lean();
      if (existing) return res.status(200).json({ feedback: existing, duplicate: true });
    }
    throw error;
  }
}

export async function listFeedback(req, res) {
  const records = await Feedback.find().sort("-createdAt").lean();
  const grouped = [];
  const recentByKey = new Map();
  const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

  for (const record of records) {
    const key = [
      String(record.email || "").trim().toLowerCase(),
      String(record.category || "GENERAL"),
      String(record.rating || ""),
      String(record.message || "").trim().toLowerCase(),
    ].join("|");
    const previous = recentByKey.get(key);
    const distance = previous
      ? Math.abs(new Date(previous.createdAt).getTime() - new Date(record.createdAt).getTime())
      : Infinity;

    if (previous && distance <= DUPLICATE_WINDOW_MS) {
      previous.duplicateCount = (previous.duplicateCount || 1) + 1;
      continue;
    }

    const visible = { ...record, duplicateCount: 1 };
    grouped.push(visible);
    recentByKey.set(key, visible);
  }

  res.json(grouped);
}

export async function updateFeedback(req, res) {
  const feedback = await Feedback.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true }).lean();
  if (!feedback) return res.status(404).json({ message: "Feedback not found" });
  res.json(feedback);
}
