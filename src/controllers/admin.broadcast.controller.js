/* =====================================================
   ADMIN BROADCAST — "Email all organizers"
   Lets an admin compose one plain-text message and blast
   it to every organizer, wrapped in a minimal, deliverability-
   safe branded HTML shell (mostly text, inline styles, no
   external images).

   The admin types PLAIN TEXT and may leave two tokens in it:
     [First Name] — we fill this per recipient
     [Your Name]  — the admin fills this themselves before sending
   We escape the body BEFORE inserting anything, so a stray
   "<" can never break the layout.

   Every send goes through sendEmail() (the provider failover
   chain), which NEVER throws — it returns { success:false } on
   total failure. We still guard each call so one bad recipient
   can never abort the batch.
===================================================== */

import User from "../models/User.js";
import { sendEmail } from "../services/emailProviders.service.js";

/* ---- constants ---------------------------------------------------- */
const SUBJECT_MIN = 3;
const BODY_MIN = 10;
const SEND_GAP_MS = 400; // gentle pacing between real sends
const FIRST_NAME_TOKEN = "[First Name]";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* First whitespace-separated token of a name, fallback "there". */
function firstNameOf(name) {
  const first = String(name || "").trim().split(/\s+/)[0];
  return first || "there";
}

/* Escape the four characters that could break HTML/attribute layout. */
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* Turn already-escaped plain text into paragraph HTML:
   blank lines split paragraphs, single newlines become <br>. */
function textToParagraphs(escaped) {
  return escaped
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map(
      (block) =>
        `<p style="margin:0 0 16px;line-height:1.6;">${block.replace(/\n/g, "<br>")}</p>`,
    )
    .join("\n");
}

/* Wrap escaped-and-personalized body text into a branded email.
   Light layout, inline styles only, Tictify wordmark in gold. */
export function renderEmailHtml(bodyText) {
  const paragraphs = textToParagraphs(bodyText);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <div style="padding:20px 0 10px;border-bottom:1px solid #e5e5e5;">
      <span style="font-size:24px;font-weight:800;letter-spacing:-0.02em;color:#080910;">Tic<span style="color:#E8C96A;">tify</span></span>
    </div>
    <div style="padding:24px 0;font-size:15px;">
${paragraphs}
    </div>
    <div style="padding:16px 0;border-top:1px solid #e5e5e5;font-size:12px;color:#8b887e;">
      Tictify &middot; tictify.ng &middot; tictify@gmail.com
    </div>
  </div>
</body>
</html>`;
}

/* Build the final HTML for one recipient: escape body, replace the
   first-name token, then wrap. */
function personalizedHtml(bodyText, name) {
  const escaped = escapeHtml(bodyText);
  // escape the name too — it's user-controlled and must not inject HTML
  const filled = escaped
    .split(FIRST_NAME_TOKEN)
    .join(escapeHtml(firstNameOf(name)));
  return renderEmailHtml(filled);
}

/* =====================================================
   GET /api/admin/broadcast/recipients
   → { count, recipients: [{ name, email }] }
   All role:"organizer" users with a non-empty email.
===================================================== */
export const getBroadcastRecipients = async (req, res) => {
  try {
    const users = await User.find({ role: "organizer" }).select("name email");
    const recipients = users
      .filter((u) => u.email && String(u.email).trim())
      .map((u) => ({ name: u.name || "", email: u.email }));
    res.json({ count: recipients.length, recipients });
  } catch (err) {
    console.error("BROADCAST RECIPIENTS ERROR:", err);
    res.status(500).json({ message: "Failed to load organizer recipients" });
  }
};

/* =====================================================
   POST /api/admin/broadcast/send
   body { subject, body, test }
===================================================== */
export const sendBroadcast = async (req, res) => {
  try {
    const subject = String(req.body?.subject ?? "").trim();
    const body = String(req.body?.body ?? "");
    const test = Boolean(req.body?.test);

    /* ---- validation ---- */
    if (subject.length < SUBJECT_MIN) {
      return res
        .status(400)
        .json({ message: `Subject must be at least ${SUBJECT_MIN} characters.` });
    }
    if (body.trim().length < BODY_MIN) {
      return res
        .status(400)
        .json({ message: `Message body must be at least ${BODY_MIN} characters.` });
    }

    /* ---- TEST: one email to the admin only ---- */
    if (test) {
      const to = req.user.email;
      const html = personalizedHtml(body, req.user.name);
      let ok = false;
      try {
        const result = await sendEmail({
          to,
          subject: `[TEST] ${subject}`,
          html,
        });
        ok = Boolean(result && result.success);
      } catch (err) {
        console.error("BROADCAST TEST SEND ERROR:", err);
        ok = false;
      }
      return res.json({ test: true, sentTo: to, ok });
    }

    /* ---- REAL BLAST ---- */
    const users = await User.find({ role: "organizer" }).select("name email");
    const recipients = users.filter((u) => u.email && String(u.email).trim());

    if (recipients.length === 0) {
      return res.status(400).json({ message: "No organizers to email yet" });
    }

    const total = recipients.length;
    let sent = 0;
    let failed = 0;
    const failedList = [];

    for (let i = 0; i < recipients.length; i++) {
      const u = recipients[i];
      try {
        const html = personalizedHtml(body, u.name);
        const result = await sendEmail({ to: u.email, subject, html });
        if (result && result.success) {
          sent += 1;
        } else {
          failed += 1;
          failedList.push({
            email: u.email,
            error:
              (result && (result.message || (result.errors || []).join(" | "))) ||
              "Send failed",
          });
        }
      } catch (err) {
        failed += 1;
        failedList.push({ email: u.email, error: err.message || "Send threw" });
      }

      // gentle pacing between sends (skip after the last one)
      if (i < recipients.length - 1) await sleep(SEND_GAP_MS);
    }

    return res.json({ sent, failed, failedList, total });
  } catch (err) {
    console.error("BROADCAST SEND ERROR:", err);
    res.status(500).json({ message: "Broadcast failed" });
  }
};
