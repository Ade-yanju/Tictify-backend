import Ticket from "../models/Ticket.js";
import Event from "../models/Event.js";

/* =====================================================
   SCAN TICKET (ORGANIZER ONLY)
===================================================== */
export const scanTicket = async (req, res) => {
  try {
    const organizerId = req.user._id;
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ message: "QR code is required" });
    }

    /* ================= FIND TICKET ================= */
    const ticket = await Ticket.findOne({ qrCode: code }).populate("event");

    if (!ticket) {
      return res.status(404).json({ message: "Invalid ticket" });
    }

    /* ================= ORGANIZER OWNERSHIP ================= */
    if (ticket.organizer.toString() !== organizerId.toString()) {
      return res.status(403).json({
        message: "You are not authorized to scan this ticket",
      });
    }

    /* ================= ALREADY SCANNED ================= */
    if (ticket.scanned) {
      return res.status(409).json({
        message: "Ticket already used",
      });
    }

    /* ================= MARK AS SCANNED ================= */
    ticket.scanned = true;
    ticket.scannedAt = new Date();
    await ticket.save();

    return res.json({
      message: "Access granted",
      ticketType: ticket.ticketType,
      eventTitle: ticket.event.title,
    });
  } catch (error) {
    console.error("SCAN ERROR:", error);
    return res.status(500).json({ message: "Scan failed" });
  }
};
