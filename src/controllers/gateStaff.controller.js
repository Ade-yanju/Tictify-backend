import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import GateStaff from "../models/GateStaff.js";
import { findEventByIdOrSlug } from "../utils/resolveEvent.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;

function safeStaff(staff) {
  return {
    _id: staff._id,
    name: staff.name,
    email: staff.email,
    isActive: Boolean(staff.isActive),
    lastLoginAt: staff.lastLoginAt || null,
    createdAt: staff.createdAt,
  };
}

async function ownedEvent(id, organizerId) {
  const event = await findEventByIdOrSlug(id);
  if (!event) return { error: { status: 404, message: "Event not found" } };
  if (String(event.organizer) !== String(organizerId)) {
    return { error: { status: 403, message: "Only the event owner can manage scanner staff" } };
  }
  return { event };
}

export async function listGateStaff(req, res) {
  try {
    const { event, error } = await ownedEvent(req.params.id, req.user._id);
    if (error) return res.status(error.status).json({ message: error.message });
    const staff = await GateStaff.find({ event: event._id })
      .sort({ createdAt: 1 })
      .lean();
    return res.json({ eventId: event._id, staff: staff.map(safeStaff) });
  } catch (error) {
    console.error("GATE STAFF LIST ERROR:", error);
    return res.status(500).json({ message: "Unable to load scanner staff." });
  }
}

export async function createGateStaff(req, res) {
  try {
    const { event, error } = await ownedEvent(req.params.id, req.user._id);
    if (error) return res.status(error.status).json({ message: error.message });

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!name) return res.status(400).json({ message: "Staff name is required." });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: "Enter a valid staff email." });
    if (password.length < PASSWORD_MIN) {
      return res.status(400).json({ message: `Password must be at least ${PASSWORD_MIN} characters.` });
    }
    if (password.length > 128) {
      return res.status(400).json({ message: "Password must be 128 characters or fewer." });
    }

    const existing = await GateStaff.findOne({ event: event._id, email });
    if (existing) {
      return res.status(409).json({ message: "That email already has scanner access for this event." });
    }

    const staff = await GateStaff.create({
      event: event._id,
      organizer: event.organizer,
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
    });

    return res.status(201).json({
      message: "Scanner account created.",
      staff: safeStaff(staff),
      scannerUrl: `${process.env.FRONTEND_URL || "https://www.tictify.ng"}/gate/login?event=${event._id}`,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "That email already has scanner access for this event." });
    }
    console.error("GATE STAFF CREATE ERROR:", error);
    return res.status(500).json({ message: "Unable to create scanner staff." });
  }
}

export async function revokeGateStaff(req, res) {
  try {
    const { event, error } = await ownedEvent(req.params.id, req.user._id);
    if (error) return res.status(error.status).json({ message: error.message });
    const staff = await GateStaff.findOneAndUpdate(
      { _id: req.params.staffId, event: event._id },
      { $set: { isActive: false } },
      { new: true },
    );
    if (!staff) return res.status(404).json({ message: "Scanner staff member not found." });
    return res.json({ message: "Scanner access revoked." });
  } catch (error) {
    console.error("GATE STAFF REVOKE ERROR:", error);
    return res.status(500).json({ message: "Unable to revoke scanner access." });
  }
}

export async function gateStaffLogin(req, res) {
  try {
    const eventKey = String(req.body?.eventId || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!eventKey || !EMAIL_RE.test(email) || !password) {
      return res.status(401).json({ message: "Enter your scanner email and password." });
    }

    const event = await findEventByIdOrSlug(eventKey);
    if (!event) return res.status(401).json({ message: "Invalid scanner login." });

    const staff = await GateStaff.findOne({ event: event._id, email, isActive: true })
      .select("+passwordHash");
    if (!staff || !(await bcrypt.compare(password, staff.passwordHash))) {
      return res.status(401).json({ message: "Invalid scanner login." });
    }
    if (event.status === "CANCELLED") {
      return res.status(403).json({ message: "This event has been cancelled." });
    }

    staff.lastLoginAt = new Date();
    await staff.save();
    const token = jwt.sign(
      { kind: "gate_staff", staffId: staff._id.toString(), eventId: event._id.toString() },
      process.env.JWT_SECRET,
      { expiresIn: "7d", jwtid: crypto.randomBytes(12).toString("hex") },
    );

    return res.json({
      token,
      staff: { id: staff._id, name: staff.name, email: staff.email },
      event: { id: event._id, title: event.title, status: event.status },
    });
  } catch (error) {
    console.error("GATE STAFF LOGIN ERROR:", error);
    return res.status(500).json({ message: "Scanner login failed." });
  }
}

export async function getGateLoginEvent(req, res) {
  try {
    const event = await findEventByIdOrSlug(req.params.eventId);
    if (!event) return res.status(404).json({ message: "Event not found" });
    return res.json({ event: { id: event._id, title: event.title, status: event.status } });
  } catch (error) {
    return res.status(404).json({ message: "Event not found" });
  }
}
