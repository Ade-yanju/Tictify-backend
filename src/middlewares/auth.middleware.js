import jwt from "jsonwebtoken";
import User from "../models/User.js";

/**
 * ===============================
 * AUTHENTICATION (JWT)
 * ===============================
 */
export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // No Authorization header
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ message: "Invalid session" });
    }

    // Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch user from DB
    const user = await User.findById(decoded.id).select("-passwordHash");

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Session expired" });
    }

    /**
     * 🔥 IMPORTANT FIX
     * We expose BOTH `_id` and `id`
     * - `_id` for Mongoose relations
     * - `id` for backward compatibility
     */
    req.user = {
      _id: user._id, // ✅ REQUIRED for Event.organizer
      id: user._id, // ✅ backward-compatible
      role: user.role,
      name: user.name,
      email: user.email,
    };

    next();
  } catch (error) {
    console.error("AUTH ERROR:", error.message);
    return res.status(401).json({ message: "Session expired" });
  }
};

/**
 * ===============================
 * ROLE-BASED ACCESS CONTROL
 * ===============================
 */
export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }

    next();
  };
};

/**
 * ===============================
 * BACKWARD-COMPATIBILITY EXPORTS
 * (PREVENTS CRASHES)
 * ===============================
 */
export const requireAuth = authenticate;
export const requireRole = (role) => authorize(role);
