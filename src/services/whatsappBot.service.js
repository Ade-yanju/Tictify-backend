import crypto from "crypto";
import mongoose from "mongoose";
import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import User from "../models/User.js";
import Wallet from "../models/Wallet.js";
import Payment from "../models/Payment.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import { sendEmail } from "./email.service.js";
import {
  effectivePrice,
  createPaymentSession,
} from "../controllers/payment.controller.js";

/* =====================================================
   WHATSAPP BOT — THE BRAIN
   Transport-agnostic: `send`/`sendImage` are injected, so
   the whole conversation can be driven in tests without
   ever touching the Cloud API.
===================================================== */

const SESSION_STALE_MS = 24 * 60 * 60 * 1000; // reset state (not the account link) after 24h
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

const frontendUrl = () => process.env.FRONTEND_URL || "https://www.tictify.ng";
const backendUrl = () =>
  process.env.BACKEND_URL || "https://tictify-backend.onrender.com";

/* ── formatting helpers ── */
const fmtNaira = (n) => `₦${Number(n || 0).toLocaleString("en-NG")}`;

function fmtDate(d) {
  try {
    return new Date(d).toLocaleDateString("en-NG", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(d);
  }
}

function earlyBirdActive(tier, at = new Date()) {
  return (
    tier &&
    tier.earlyBirdPrice != null &&
    tier.earlyBirdPrice >= 0 &&
    tier.earlyBirdUntil &&
    new Date(tier.earlyBirdUntil) > at
  );
}

function fromPriceLabel(event) {
  const prices = (event.ticketTypes || []).map((t) => effectivePrice(t));
  if (!prices.length) return "—";
  const min = Math.min(...prices);
  return min === 0 ? "Free" : `from ${fmtNaira(min)}`;
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

/* ── canned copy ── */
function mainMenuText() {
  return (
    `🎟️ *Welcome to Tictify!*\n` +
    `Buy event tickets right here on WhatsApp.\n\n` +
    `*1.* 🔎 Browse events\n` +
    `*2.* 🎫 My tickets\n` +
    `*3.* 💼 Organizer zone\n` +
    `*4.* ❓ Help\n\n` +
    `Reply with a number.`
  );
}

function orgMenuText() {
  return (
    `💼 *Organizer zone*\n\n` +
    `*1.* 📊 Balance & stats\n` +
    `*2.* 💸 Withdraw\n` +
    `*3.* 🔓 Unlink this number\n\n` +
    `Reply with a number, or *menu* for the main menu.`
  );
}

function helpText() {
  return (
    `❓ *Tictify Help*\n\n` +
    `Here's what I can do:\n` +
    `🔎 *Browse events* — see what's on and buy tickets without leaving this chat\n` +
    `🎫 *My tickets* — resend your QR codes to this chat\n` +
    `💼 *Organizer zone* — check your sales and balance on the go\n\n` +
    `💳 Payments are handled securely by Paystack.\n` +
    `📧 Every ticket also lands in your email.\n\n` +
    `Need a human? Contact *tictify@gmail.com*\n\n` +
    `Type *menu* to get started.`
  );
}

/* ── session helpers ── */
async function setSession(session, state, data) {
  session.state = state;
  session.data = data;
  session.markModified("data");
  await session.save();
}

function clearOtpFields(session) {
  session.otpHash = undefined;
  session.otpExpires = undefined;
  session.otpAttempts = 0;
}

/* =====================================================
   ENTRY POINT — routes on session.state, never crashes
===================================================== */
export async function handleIncoming(phone, text, { send, sendImage }) {
  try {
    const input = String(text || "").trim();

    let session = await WhatsAppSession.findOne({ phone });
    if (!session) {
      session = await WhatsAppSession.create({ phone, state: "MENU", data: {} });
    }

    /* Stale conversation (>24h): back to the main menu. The
       organizerUser link is permanent — only state/data reset. */
    const stale =
      session.updatedAt &&
      Date.now() - new Date(session.updatedAt).getTime() > SESSION_STALE_MS;
    if (stale && session.state !== "MENU") {
      clearOtpFields(session);
      await setSession(session, "MENU", {});
      return send(phone, `👋 Welcome back!\n\n${mainMenuText()}`);
    }

    /* Global escape hatches work from ANY state */
    const lower = input.toLowerCase();
    if (["menu", "hi", "hello", "hey", "start"].includes(lower) || input === "") {
      clearOtpFields(session);
      await setSession(session, "MENU", {});
      return send(phone, mainMenuText());
    }

    switch (session.state) {
      case "BROWSING":
        return await handleBrowsing(session, input, send, phone);
      case "PICK_TIER":
        return await handlePickTier(session, input, send, phone);
      case "QTY":
        return await handleQty(session, input, send, phone);
      case "NAME":
        return await handleName(session, input, send, phone);
      case "EMAIL":
        return await handleEmail(session, input, send, phone);
      case "TICKETS_EMAIL":
        return await handleTicketsEmail(session, input, send, sendImage, phone);
      case "ORG_EMAIL":
        return await handleOrgEmail(session, input, send, phone);
      case "ORG_OTP":
        return await handleOrgOtp(session, input, send, phone);
      case "ORG_MENU":
        return await handleOrgMenu(session, input, send, phone);
      case "MENU":
      default:
        return await handleMenu(session, input, send, phone);
    }
  } catch (err) {
    console.error("WHATSAPP BOT ERROR:", err);
    try {
      await send(phone, "⚠️ Something went wrong. Type *menu* to start over.");
    } catch (sendErr) {
      console.error("WHATSAPP BOT SEND ERROR:", sendErr);
    }
  }
}

/* ================= MAIN MENU ================= */
async function handleMenu(session, input, send, phone) {
  switch (input) {
    case "1": {
      const events = await Event.find({ status: "LIVE", date: { $gt: new Date() } })
        .sort("date")
        .limit(8)
        .lean();

      if (!events.length) {
        await setSession(session, "MENU", {});
        return send(
          phone,
          `😔 No upcoming events right now.\n\nNew events go live all the time — check back soon!\n\nType *menu* to go back.`,
        );
      }

      const lines = events.map(
        (e, i) =>
          `*${i + 1}.* ${e.title}\n` +
          `   📅 ${fmtDate(e.date)}${e.city ? ` · 📍 ${e.city}` : ""}\n` +
          `   💰 ${fromPriceLabel(e)}`,
      );
      await setSession(session, "BROWSING", {
        eventIds: events.map((e) => String(e._id)),
      });
      return send(
        phone,
        `🔎 *Upcoming events*\n\n${lines.join("\n\n")}\n\nReply with a number to see details.`,
      );
    }

    case "2":
      await setSession(session, "TICKETS_EMAIL", {});
      return send(
        phone,
        `🎫 *My tickets*\n\nWhat email did you use when buying? I'll fetch your most recent tickets and resend the QR codes here.`,
      );

    case "3":
      if (session.organizerUser) {
        await setSession(session, "ORG_MENU", {});
        return send(phone, orgMenuText());
      }
      await setSession(session, "ORG_EMAIL", {});
      return send(
        phone,
        `💼 *Organizer zone*\n\nWhat's your Tictify account email? We'll send a *6-digit code* there to verify it's really you.`,
      );

    case "4":
      await setSession(session, "MENU", {});
      return send(phone, helpText());

    default:
      /* unknown input → main menu (spec: any unrecognised text) */
      await setSession(session, "MENU", {});
      return send(phone, mainMenuText());
  }
}

/* ================= BROWSING → EVENT DETAIL ================= */
async function handleBrowsing(session, input, send, phone) {
  const ids = Array.isArray(session.data?.eventIds) ? session.data.eventIds : [];
  const idx = parseInt(input, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    return send(
      phone,
      `Please reply with a number from the list (1-${ids.length || 1}), or type *menu*.`,
    );
  }

  const event = await Event.findById(ids[idx - 1]).lean();
  const now = new Date();
  if (!event || event.status !== "LIVE" || new Date(event.date) <= now) {
    await setSession(session, "MENU", {});
    return send(
      phone,
      `😕 That event is no longer available.\n\nType *menu* to browse again.`,
    );
  }

  const tierLines = (event.ticketTypes || []).map((t, i) => {
    const price = effectivePrice(t, now);
    const label = price === 0 ? "Free" : fmtNaira(price);
    const eb = earlyBirdActive(t, now)
      ? ` 🐤 EARLY BIRD (normally ${fmtNaira(t.price)})`
      : "";
    const soldOut = t.quantity - (t.sold || 0) <= 0 ? " — ❌ SOLD OUT" : "";
    return `*${i + 1}.* ${t.name} — ${label}${eb}${soldOut}`;
  });

  await setSession(session, "PICK_TIER", {
    eventId: String(event._id),
    eventTitle: event.title,
    tierNames: (event.ticketTypes || []).map((t) => t.name),
  });

  return send(
    phone,
    `🎟️ *${event.title}*\n` +
      `📅 ${fmtDate(event.date)}\n` +
      `📍 ${event.location}${event.city ? `, ${event.city}` : ""}\n\n` +
      `*Tickets:*\n${tierLines.join("\n")}\n\n` +
      `Reply with a ticket number to book, or *menu* to cancel.`,
  );
}

/* ================= PICK TIER → QUANTITY ================= */
async function handlePickTier(session, input, send, phone) {
  const names = Array.isArray(session.data?.tierNames) ? session.data.tierNames : [];
  const idx = parseInt(input, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > names.length) {
    return send(
      phone,
      `Please reply with a ticket number from the list (1-${names.length || 1}), or type *menu*.`,
    );
  }

  await setSession(session, "QTY", { ...session.data, tierName: names[idx - 1] });
  return send(phone, `How many *${names[idx - 1]}* tickets would you like? (1-10)`);
}

/* ================= QUANTITY → NAME ================= */
async function handleQty(session, input, send, phone) {
  const qty = parseInt(input, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
    return send(phone, `Please send a number between *1* and *10*.`);
  }

  await setSession(session, "NAME", { ...session.data, qty });
  return send(phone, `Great! What's your *full name*? (it goes on the ticket)`);
}

/* ================= NAME → EMAIL ================= */
async function handleName(session, input, send, phone) {
  if (input.length < 3) {
    return send(phone, `Please send your full name (at least 3 characters).`);
  }

  await setSession(session, "EMAIL", { ...session.data, name: input });
  return send(
    phone,
    `📧 And your *email address*? Your ticket will be sent there too.`,
  );
}

/* ================= EMAIL → CREATE PAYMENT ================= */
async function handleEmail(session, input, send, phone) {
  const email = input.toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return send(
      phone,
      `Hmm, that doesn't look like a valid email. Try again (e.g. ada@gmail.com), or type *menu* to cancel.`,
    );
  }

  const d = session.data || {};
  const result = await createPaymentSession({
    eventId: d.eventId,
    ticketType: d.tierName,
    quantity: d.qty,
    name: d.name,
    email,
    waPhone: phone, // QR lands back in this chat once payment confirms
  });

  await setSession(session, "MENU", {});

  if (!result.ok) {
    return send(
      phone,
      `😕 Could not start the payment: ${result.message || "please try again"}.\n\nType *menu* to start over.`,
    );
  }

  /* FREE ticket — already minted; QR delivery to this chat fires
     inside createPaymentSession (waPhone path) */
  if (result.free) {
    return send(
      phone,
      `🎉 *You're in!*\n\n` +
        `Your FREE ticket for *${d.eventTitle}* is confirmed.\n` +
        `Reference: ${result.reference}\n\n` +
        `📧 It's on its way to ${email} — and your QR code is arriving right here too. See you there!`,
    );
  }

  /* PAID — hand over the Paystack link with the exact fee breakdown */
  return send(
    phone,
    `🧾 *Order summary — ${d.eventTitle}*\n\n` +
      `${result.quantity} × ${d.tierName} @ ${fmtNaira(result.unitPrice)} = ${fmtNaira(result.subtotal)}\n` +
      `Platform fee: ${fmtNaira(result.platformFee)}\n` +
      `Processing fee: ${fmtNaira(result.processingFee)}\n` +
      `*Total: ${fmtNaira(result.total)}*\n\n` +
      `👉 Pay securely with Paystack:\n${result.paymentUrl}\n\n` +
      `The moment payment confirms, your QR ticket will arrive *right here* and by email. 🎟️`,
  );
}

/* ================= MY TICKETS ================= */
async function handleTicketsEmail(session, input, send, sendImage, phone) {
  const email = input.toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return send(
      phone,
      `That doesn't look like an email. Try again, or type *menu* to cancel.`,
    );
  }

  const tickets = await Ticket.find({
    buyerEmail: new RegExp(`^${escapeRegex(email)}$`, "i"),
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate("event", "title date")
    .lean();

  await setSession(session, "MENU", {});

  if (!tickets.length) {
    return send(
      phone,
      `😕 No tickets found for *${email}*.\n\nDouble-check the email you used at checkout, or type *menu* to browse events.`,
    );
  }

  await send(
    phone,
    `🎫 Found ${tickets.length} ticket${tickets.length > 1 ? "s" : ""} — sending your QR code${tickets.length > 1 ? "s" : ""} now…`,
  );

  for (const t of tickets) {
    const ev = t.event || {};
    await sendImage(
      phone,
      `${backendUrl()}/api/tickets/qr/${t.paymentRef}`,
      `🎟️ ${ev.title || "Event"}\n📅 ${ev.date ? fmtDate(ev.date) : "—"}\nRef: ${t.paymentRef}\nShow this QR at the gate.`,
    );
  }

  return send(phone, `That's everything! Type *menu* for the main menu.`);
}

/* ================= ORGANIZER: LINK ACCOUNT (EMAIL) ================= */
async function handleOrgEmail(session, input, send, phone) {
  const email = input.toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return send(
      phone,
      `That doesn't look like an email. Try again, or type *menu* to cancel.`,
    );
  }

  const user = await User.findOne({
    email,
    role: { $in: ["organizer", "admin"] },
  });

  if (user) {
    const otp = String(crypto.randomInt(100000, 1000000));
    session.otpHash = sha256(otp);
    session.otpExpires = new Date(Date.now() + OTP_TTL_MS);
    session.otpAttempts = 0;
    await setSession(session, "ORG_OTP", { linkUserId: String(user._id) });

    sendEmail({
      to: user.email,
      subject: `Your Tictify WhatsApp code: ${otp}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#f9fafb;border-radius:16px;">
          <h2 style="color:#1a1a1a;margin-top:0;">Link WhatsApp to your Tictify account</h2>
          <p style="color:#555;line-height:1.7;">Someone (hopefully you) asked to connect a WhatsApp number ending in
          <strong>····${String(phone).slice(-4)}</strong> to your organizer account.</p>
          <div style="text-align:center;background:#fff;padding:18px;border-radius:12px;margin:16px 0;">
            <p style="margin:0 0 6px;color:#888;font-size:12px;">YOUR CODE (expires in 10 minutes)</p>
            <p style="margin:0;font-size:32px;font-weight:800;letter-spacing:8px;color:#1a1a1a;">${otp}</p>
          </div>
          <p style="color:#B00020;font-size:13px;line-height:1.7;"><strong>Didn't request this?</strong> Ignore this email —
          nothing happens without the code. If you're worried, change your password and contact tictify@gmail.com.</p>
        </div>
      `,
    }).catch((e) => console.error("WA link OTP email failed:", e.message));
  } else {
    /* No enumeration: unknown emails walk the exact same path with an
       unmatchable code — wrong-code replies are indistinguishable. */
    session.otpHash = sha256(crypto.randomBytes(16).toString("hex"));
    session.otpExpires = new Date(Date.now() + OTP_TTL_MS);
    session.otpAttempts = 0;
    await setSession(session, "ORG_OTP", {});
  }

  return send(
    phone,
    `🔐 If an organizer account exists for that email, we've sent it a *6-digit code*.\n\nReply with the code here to link this number. (It expires in 10 minutes.)`,
  );
}

/* ================= ORGANIZER: LINK ACCOUNT (OTP) ================= */
async function handleOrgOtp(session, input, send, phone) {
  if (!/^\d{6}$/.test(input)) {
    return send(
      phone,
      `Please send the *6-digit code* from your email, or type *menu* to cancel.`,
    );
  }

  if (!session.otpHash || !session.otpExpires || session.otpExpires < new Date()) {
    clearOtpFields(session);
    await setSession(session, "MENU", {});
    return send(
      phone,
      `⌛ That code has expired. Type *3* from the *menu* to start again.`,
    );
  }

  if (sha256(input) !== session.otpHash || !session.data?.linkUserId) {
    session.otpAttempts = (session.otpAttempts || 0) + 1;
    const left = OTP_MAX_ATTEMPTS - session.otpAttempts;
    if (left <= 0) {
      clearOtpFields(session);
      await setSession(session, "MENU", {});
      return send(
        phone,
        `❌ Too many wrong attempts. Type *3* from the *menu* to start again.`,
      );
    }
    await session.save();
    return send(
      phone,
      `❌ Wrong code — ${left} attempt${left === 1 ? "" : "s"} left.`,
    );
  }

  /* Correct code → permanent link */
  session.organizerUser = new mongoose.Types.ObjectId(session.data.linkUserId);
  clearOtpFields(session);
  await setSession(session, "ORG_MENU", {});
  return send(
    phone,
    `✅ *Account linked!* This WhatsApp number is now connected to your organizer account.\n\n${orgMenuText()}`,
  );
}

/* ================= ORGANIZER: SUBMENU ================= */
async function handleOrgMenu(session, input, send, phone) {
  if (!session.organizerUser) {
    await setSession(session, "MENU", {});
    return send(phone, mainMenuText());
  }

  switch (input) {
    case "1": {
      const orgId = new mongoose.Types.ObjectId(String(session.organizerUser));
      const [wallet, sales] = await Promise.all([
        Wallet.findOne({ organizer: orgId }).lean(),
        Payment.aggregate([
          { $match: { organizer: orgId, status: "SUCCESS" } },
          {
            $group: {
              _id: null,
              ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
              revenue: { $sum: "$organizerAmount" },
            },
          },
        ]),
      ]);

      return send(
        phone,
        `📊 *Your stats*\n\n` +
          `💰 Wallet balance: ${fmtNaira(wallet?.balance || 0)}\n` +
          `📈 Total earnings: ${fmtNaira(wallet?.totalEarnings || 0)}\n` +
          `🎫 Tickets sold: ${sales[0]?.ticketsSold || 0}\n` +
          `🧾 Sales revenue: ${fmtNaira(sales[0]?.revenue || 0)}\n\n` +
          orgMenuText(),
      );
    }

    case "2":
      return send(
        phone,
        `💸 *Withdrawals*\n\nFor your security, withdrawals happen on the Tictify dashboard and are protected by a *6-digit email code* — no money moves without it.\n\n👉 ${frontendUrl()}/organizer/withdraw`,
      );

    case "3":
      session.organizerUser = undefined;
      await setSession(session, "MENU", {});
      return send(
        phone,
        `🔓 Done — this WhatsApp number is no longer linked to your organizer account.\n\nType *menu* anytime.`,
      );

    default:
      return send(phone, orgMenuText());
  }
}
