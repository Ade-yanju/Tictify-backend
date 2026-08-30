import Feedback from "../models/Feedback.js";

export async function submitFeedback(req, res) {
  const message = String(req.body.message || "").trim();
  if (message.length < 10) return res.status(400).json({ message: "Please enter at least 10 characters." });
  const feedback = await Feedback.create({ user: req.user._id, name: req.user.name, email: req.user.email, category: req.body.category, rating: req.body.rating, message });
  res.status(201).json({ feedback });
}

export async function listFeedback(req, res) {
  res.json(await Feedback.find().sort("-createdAt").lean());
}

export async function updateFeedback(req, res) {
  const feedback = await Feedback.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true }).lean();
  if (!feedback) return res.status(404).json({ message: "Feedback not found" });
  res.json(feedback);
}
