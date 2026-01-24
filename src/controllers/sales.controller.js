// src/controllers/sales.controller.js
import Ticket from "../models/Ticket.js";

export const getOrganizerSales = async (req, res) => {
  try {
    const tickets = await Ticket.find({
      organizer: req.user._id,
    }).populate("event", "title");

    const totalRevenue = tickets.reduce((sum, t) => sum + t.amountPaid, 0);

    return res.json({
      totalRevenue,
      totalTickets: tickets.length,
      tickets,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load sales" });
  }
};
