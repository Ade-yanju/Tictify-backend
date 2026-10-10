import jwt from "jsonwebtoken";
import GateStaff from "../models/GateStaff.js";
import User from "../models/User.js";

function tokenFromRequest(req) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  return req.cookies?.token || null;
}

/* Normal organiser/admin tokens and dedicated gate-staff tokens are both
   accepted by the small set of ticket-gate routes. */
export async function authenticateScanAccess(req, res, next) {
  const token = tokenFromRequest(req);
  if (!token) return res.status(401).json({ message: "Authentication required" });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({
      message:
        error?.name === "TokenExpiredError"
          ? "Session expired. Please login again."
          : "Invalid scanner session. Please login again.",
    });
  }

  try {
    if (decoded.kind !== "gate_staff") {
      const user = await User.findById(decoded.id).select("-passwordHash").lean();
      if (!user || !user.isActive) {
        return res.status(401).json({ message: "User no longer exists or is suspended." });
      }
      req.user = {
        _id: user._id,
        id: user._id,
        role: user.role,
        name: user.name,
        email: user.email,
        affiliateCode: user.affiliateCode,
        whatsapp: user.whatsapp || null,
        whatsappVerifiedAt: user.whatsappVerifiedAt || null,
      };
      return next();
    }

    const staff = await GateStaff.findOne({
      _id: decoded.staffId,
      isActive: true,
    }).lean();
    if (!staff) {
      return res.status(401).json({ message: "Scanner access has been revoked." });
    }

    req.gateStaff = {
      _id: staff._id,
      eventId: staff.event,
      organizerId: staff.organizer,
      name: staff.name,
      email: staff.email,
    };
    req.user = {
      _id: staff.organizer,
      id: staff.organizer,
      role: "gate_staff",
      name: staff.name,
      email: staff.email,
      gateStaffId: staff._id,
      gateEventId: staff.event,
    };
    return next();
  } catch (error) {
    console.error("GATE AUTH ERROR:", error.message);
    return res.status(500).json({ message: "Scanner authentication failed." });
  }
}

export function allowScanAccess(req, res, next) {
  if (["organizer", "admin", "gate_staff"].includes(req.user?.role)) {
    return next();
  }
  return res.status(403).json({ message: "Scanner access required" });
}

export function gateStaffEventMatches(req, eventId) {
  return (
    req.user?.role !== "gate_staff" ||
    String(req.gateStaff?.eventId) === String(eventId)
  );
}
