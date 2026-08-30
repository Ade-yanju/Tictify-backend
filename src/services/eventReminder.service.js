import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import EventReminder from "../models/EventReminder.js";
import { sendEmail } from "./email.service.js";
import { sendUtilityTemplate } from "./whatsapp.service.js";
import PostEventReport from "../models/PostEventReport.js";
import User from "../models/User.js";

export async function sendUpcomingEventReminders() {
  const now = Date.now();
  const events = await Event.find({ status: "LIVE", date: { $gte: new Date(now + 23 * 3600000), $lte: new Date(now + 25 * 3600000) } }).lean();
  for (const event of events) {
    if (await EventReminder.exists({ event: event._id })) continue;
    const guests = await Ticket.distinct("buyerEmail", { event: event._id });
    const phones = await Ticket.distinct("waPhone", { event: event._id, waPhone: { $exists: true, $ne: "" } });
    await Promise.all(guests.map(email => sendEmail({ to: email, subject: `Reminder: ${event.title} is tomorrow`, html: `<p>Your event <strong>${event.title}</strong> is tomorrow.</p><p>We look forward to seeing you there. Keep your QR ticket ready for entry.</p>` })));
    await Promise.all(phones.map(phone => sendUtilityTemplate(phone, [event.title])));
    await EventReminder.create({ event: event._id });
  }
}

export async function sendPostEventReports() {
  const now = Date.now();
  const events = await Event.find({ status: { $in: ["LIVE", "ENDED"] }, endDate: { $gte: new Date(now - 25 * 3600000), $lte: new Date(now - 23 * 3600000) } }).lean();
  for (const event of events) {
    if (await PostEventReport.exists({ event: event._id })) continue;
    if (event.status === "LIVE") await Event.updateOne({ _id: event._id }, { $set: { status: "ENDED" } });
    const [sold, scanned, organizer] = await Promise.all([
      Ticket.countDocuments({ event: event._id }),
      Ticket.countDocuments({ event: event._id, scanned: true }),
      User.findById(event.organizer).select("email name").lean(),
    ]);
    const guests = await Ticket.distinct("buyerEmail", { event: event._id });
    const revenue = (await Ticket.aggregate([{ $match: { event: event._id } }, { $group: { _id: null, total: { $sum: "$amountPaid" } } }]))[0]?.total || 0;
    if (organizer?.email) await sendEmail({ to: organizer.email, subject: `Your ${event.title} performance report`, html: `<h2>${event.title} — event report</h2><p>Thanks for using Tictify, ${organizer.name || "Organizer"}.</p><ul><li>Tickets sold: <strong>${sold}</strong></li><li>Guests scanned: <strong>${scanned}</strong></li><li>Attendance rate: <strong>${sold ? Math.round(scanned / sold * 100) : 0}%</strong></li><li>Ticket revenue: <strong>₦${Number(revenue).toLocaleString()}</strong></li></ul><p>Use these insights to plan your next event.</p>` });
    await Promise.all(guests.map(email => sendEmail({ to: email, subject: `How was ${event.title}?`, html: `<h2>Thanks for attending ${event.title}</h2><p>We hope you had a great time. Your feedback helps Tictify improve.</p><p><a href="${process.env.FRONTEND_URL || "https://www.tictify.ng"}/feedback?source=post-event">Share your feedback</a></p>` })));
    await PostEventReport.create({ event: event._id });
  }
}
