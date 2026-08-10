import User from "../models/User.js";
import { normalizeWhatsApp } from "../utils/phone.js";

/* =====================================================
   REQUIRE WHATSAPP — gate for actions that need a
   reachable number on the account.

   Mounted on the paths where a missing number would
   otherwise cause silent downstream failure:
     • POST /events          — the bot links events to a handset
     • POST /withdrawals/request — payouts need a reachable number

   Deliberately NOT mounted on edits or reads, so nobody is
   locked out of fixing a live event mid-sale (see the note in
   routes/event.routes.js).

   Must run AFTER `authenticate`. The number rides along on
   req.user (auth.middleware.js sets it from the loaded doc), so
   the common path costs no extra query. The DB fallback below
   only fires for auth paths that predate that field.

   The 403 carries `code: "WHATSAPP_REQUIRED"` so the dashboard
   can show its "add your number" prompt instead of a raw error —
   match on the code, never on the message text.
===================================================== */
export const requireWhatsApp = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }

    let { whatsapp } = req.user;

    /* undefined = this auth path never loaded the field (vs. null,
       which is a loaded-and-genuinely-absent number). Only the former
       is worth a lookup. */
    if (whatsapp === undefined) {
      const fresh = await User.findById(req.user.id).select("whatsapp");
      whatsapp = fresh?.whatsapp || null;
      req.user.whatsapp = whatsapp;
    }

    /* Re-normalise rather than trusting the stored shape: documents
       written before utils/phone.js existed may hold "+234 801…" or a
       local "0801…", which would never match the E.164 form the Cloud
       API sends. A value that can't normalise is treated as missing. */
    const canonical = normalizeWhatsApp(whatsapp);
    if (!canonical) {
      return res.status(403).json({
        code: "WHATSAPP_REQUIRED",
        message:
          "Add your WhatsApp number to your profile first — it's how we link your events to the bot and reach you about sales.",
      });
    }

    /* Hand the canonical form downstream so callers never re-parse. */
    req.user.whatsapp = canonical;
    return next();
  } catch (err) {
    console.error("REQUIRE WHATSAPP ERROR:", err.message);
    return res
      .status(500)
      .json({ message: "Could not verify your profile. Please try again." });
  }
};

export default requireWhatsApp;
