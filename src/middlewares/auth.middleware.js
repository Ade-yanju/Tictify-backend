import jwt from "jsonwebtoken";
import User from "../models/User.js";

/* =====================================================
   TOKEN EXTRACTOR — Bearer header + cookie fallback
===================================================== */
const extractToken = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (token) return token;
  }

  // Cookie fallback (if you ever add cookie-based auth)
  if (req.cookies?.token) {
    return req.cookies.token;
  }

  return null;
};

/* =====================================================
   AUTHENTICATE — MUST BE LOGGED IN
===================================================== */
export const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (!token) {
      return res.status(401).json({ message: "Authentication required" });
    }

    // Granular JWT error handling
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res
          .status(401)
          .json({ message: "Session expired. Please login again." });
      }
      if (err.name === "JsonWebTokenError") {
        return res
          .status(401)
          .json({ message: "Invalid token. Please login again." });
      }
      return res.status(401).json({ message: "Token verification failed." });
    }

    // Fetch user from DB
    const user = await User.findById(decoded.id).select("-passwordHash");

    if (!user) {
      return res.status(401).json({ message: "User no longer exists." });
    }

    if (!user.isActive) {
      return res
        .status(403)
        .json({ message: "Your account has been suspended. Contact support." });
    }

    /*
     * 🔥 Expose BOTH _id and id
     * - _id for Mongoose relations (Event.organizer, Wallet.organizer etc.)
     * - id  for backward compatibility
     */
    req.user = {
      _id: user._id,
      id: user._id,
      role: user.role,
      name: user.name,
      email: user.email,
    };

    next();
  } catch (error) {
    console.error("AUTH ERROR:", error.message);
    return res
      .status(500)
      .json({ message: "Authentication error. Please try again." });
  }
};

/* =====================================================
   AUTHORIZE — ROLE-BASED ACCESS CONTROL
   Usage: authorize("organizer", "admin")
===================================================== */
export const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: `Access denied. Required role: ${allowedRoles.join(" or ")}`,
      });
    }

    next();
  };
};

/* =====================================================
   OPTIONAL AUTH — attaches user if token exists
   but does NOT block request if no token.
   Use on public routes that behave differently
   when logged in (e.g. event detail pages)
===================================================== */
export const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-passwordHash");

    if (user && user.isActive) {
      req.user = {
        _id: user._id,
        id: user._id,
        role: user.role,
        name: user.name,
        email: user.email,
      };
    }

    next();
  } catch {
    // Invalid/expired token on optional route — continue anonymously
    next();
  }
};

/* =====================================================
   CONVENIENCE SHORTHANDS
   Drop-in replacements across all your route files
===================================================== */

// Any logged-in user
export const protect = authenticate;

// Role shorthands
export const organizerOnly = [authenticate, authorize("organizer")];
export const adminOnly = [authenticate, authorize("admin")];
export const anyRole = [authenticate, authorize("organizer", "admin", "user")];

/* =====================================================
   BACKWARD-COMPATIBLE EXPORTS
   (prevents crashes in existing route files)
===================================================== */
export const requireAuth = authenticate;
export const requireRole = (role) => authorize(role);
