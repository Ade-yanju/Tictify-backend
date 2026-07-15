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
  renderButtonsAsText,
  renderListAsText,
} from "./whatsapp.service.js";
import {
  effectivePrice,
  createPaymentSession,
} from "../controllers/payment.controller.js";
import { resolveDiscount } from "../controllers/discount.controller.js";

/* =====================================================
   WHATSAPP BOT — THE BRAIN
   Transport-agnostic: send/sendImage/sendButtons/sendList
   are injected, so the whole conversation can be driven
   in tests without ever touching the Cloud API.

   Interactive ids are ALWAYS the exact string the state
   machine accepts as typed input ("1", "2", "skip", …),
   so taps and typed numbers are interchangeable.
===================================================== */

const SESSION_STALE_MS = 24 * 60 * 60 * 1000; // reset state (not the account link) after 24h
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/* promo attribution: "ref CODE" anywhere in a message */
const REF_RE = /\bref[ :]+([A-Za-z0-9-]{2,30})\b/i;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

/* category options come straight from the Event schema enum */
const EVENT_CATEGORIES = Event.schema.path("category").enumValues;

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

/* Accept YYYY-MM-DD or DD/MM/YYYY; must be a real, FUTURE calendar day.
   Events start at 6pm on that day (exact times editable on the website). */
function parseEventDate(input) {
  const s = String(input).trim();
  let y, m, d;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    y = +match[1]; m = +match[2]; d = +match[3];
  } else {
    match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    d = +match[1]; m = +match[2]; y = +match[3];
  }
  const date = new Date(y, m - 1, d, 18, 0, 0); // 6pm start
  if (
    isNaN(date.getTime()) ||
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d
  ) {
    return null; // rejects 31/02/2026 etc.
  }
  if (date <= new Date()) return null; // must be future
  return date;
}

/* ── transport helpers: interactive first, numbered text otherwise.
   A stub (or a failed API call) returning success:false triggers the
   text fallback via plain send — the bot never goes silent. ── */
async function uiButtons(t, phone, body, buttons) {
  if (typeof t.sendButtons === "function") {
    const r = await Promise.resolve(t.sendButtons(phone, body, buttons)).catch(
      () => null,
    );
    if (r?.success) return r;
  }
  return t.send(phone, renderButtonsAsText(body, buttons));
}

async function uiList(t, phone, body, buttonText, rows) {
  if (typeof t.sendList === "function") {
    const r = await Promise.resolve(
      t.sendList(phone, body, buttonText, rows),
    ).catch(() => null);
    if (r?.success) return r;
  }
  return t.send(phone, renderListAsText(body, rows));
}

/* ── canned copy ── */
const MENU_ROWS = [
  { id: "1", title: "🔎 Browse events", description: "See what's on and buy right here" },
  { id: "2", title: "🎫 My tickets", description: "Resend your QR codes to this chat" },
  { id: "3", title: "💼 Organizer zone", description: "Sales, balance & event creation" },
  { id: "4", title: "❓ Help", description: "What this bot can do" },
];

function menuBody(promoter) {
  return (
    (promoter ? `🎁 Shopping via promo code *${promoter}*\n\n` : "") +
    `🎟️ *Welcome to Tictify!*\n` +
    `Buy event tickets right here on WhatsApp.`
  );
}

async function showMainMenu(t, phone, session) {
  return uiList(t, phone, menuBody(session?.data?.promoter), "Menu", MENU_ROWS);
}

const ORG_MENU_ROWS = [
  { id: "1", title: "📊 Balance & stats", description: "Wallet, earnings, tickets sold" },
  { id: "2", title: "💸 Withdraw", description: "OTP-protected payout to your bank" },
  { id: "3", title: "🔓 Unlink this number", description: "Disconnect this WhatsApp" },
  { id: "4", title: "➕ Create event", description: "Set up a new event from chat" },
];

async function showOrgMenu(t, phone, prefix = "") {
  return uiList(t, phone, `${prefix}💼 *Organizer zone*`, "Options", ORG_MENU_ROWS);
}

function helpText() {
  return (
    `❓ *Tictify Help*\n\n` +
    `Here's what I can do:\n` +
    `🔎 *Browse events* — see what's on and buy tickets without leaving this chat (card, payment link, or bank transfer)\n` +
    `🎫 *My tickets* — resend your QR codes to this chat\n` +
    `💼 *Organizer zone* — check sales, balance, even create events on the go\n` +
    `🏷️ Got a discount or promo code? You can use both right here.\n\n` +
    `💳 Payments are handled securely by Paystack.\n` +
    `📧 Every ticket also lands in your email.\n\n` +
    `Need a human? Contact *tictify@gmail.com*\n\n` +
    `Type *menu* to get started.`
  );
}

/* ── session helpers ── */

/* data.promoter (affiliate attribution) survives every state hop until
   a new "ref CODE" message replaces it — mirrors the web's ?ref= link */
async function setSession(session, state, data = {}) {
  const promoter = data.promoter ?? session.data?.promoter;
  session.state = state;
  session.data = promoter ? { ...data, promoter } : { ...data };
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
export async function handleIncoming(phone, text, transport) {
  const t = transport || {};
  try {
    const input = String(text || "").trim();

    let session = await WhatsAppSession.findOne({ phone });
    if (!session) {
      session = await WhatsAppSession.create({ phone, state: "MENU", data: {} });
    }

    /* 🎁 Promo attribution: "ref CODE" anywhere, from ANY state */
    const refMatch = input.match(REF_RE);
    if (refMatch) {
      clearOtpFields(session);
      await setSession(session, "MENU", { promoter: refMatch[1].toUpperCase() });
      return showMainMenu(t, phone, session);
    }

    /* Stale conversation (>24h): back to the main menu. The
       organizerUser link is permanent — only state/data reset. */
    const stale =
      session.updatedAt &&
      Date.now() - new Date(session.updatedAt).getTime() > SESSION_STALE_MS;
    if (stale && session.state !== "MENU") {
      clearOtpFields(session);
      await setSession(session, "MENU", {});
      await t.send(phone, "👋 Welcome back!");
      return showMainMenu(t, phone, session);
    }

    /* Global escape hatches work from ANY state */
    const lower = input.toLowerCase();
    if (["menu", "hi", "hello", "hey", "start"].includes(lower) || input === "") {
      clearOtpFields(session);
      await setSession(session, "MENU", {});
      return showMainMenu(t, phone, session);
    }

    /* organizer-only states need a live link */
    if (
      (session.state === "ORG_MENU" || session.state.startsWith("EV_")) &&
      !session.organizerUser
    ) {
      await setSession(session, "MENU", {});
      return showMainMenu(t, phone, session);
    }

    switch (session.state) {
      case "BROWSING":
        return await handleBrowsing(session, input, t, phone);
      case "PICK_TIER":
        return await handlePickTier(session, input, t, phone);
      case "QTY":
        return await handleQty(session, input, t, phone);
      case "NAME":
        return await handleName(session, input, t, phone);
      case "EMAIL":
        return await handleEmail(session, input, t, phone);
      case "DISCOUNT":
        return await handleDiscount(session, input, t, phone);
      case "PAY_METHOD":
        return await handlePayMethod(session, input, t, phone);
      case "TICKETS_EMAIL":
        return await handleTicketsEmail(session, input, t, phone);
      case "ORG_EMAIL":
        return await handleOrgEmail(session, input, t, phone);
      case "ORG_OTP":
        return await handleOrgOtp(session, input, t, phone);
      case "ORG_MENU":
        return await handleOrgMenu(session, input, t, phone);
      case "EV_TITLE":
        return await handleEvTitle(session, input, t, phone);
      case "EV_DATE":
        return await handleEvDate(session, input, t, phone);
      case "EV_LOCATION":
        return await handleEvLocation(session, input, t, phone);
      case "EV_CITY":
        return await handleEvCity(session, input, t, phone);
      case "EV_CATEGORY":
        return await handleEvCategory(session, input, t, phone);
      case "EV_TICKET_NAME":
        return await handleEvTicketName(session, input, t, phone);
      case "EV_PRICE":
        return await handleEvPrice(session, input, t, phone);
      case "EV_QTY":
        return await handleEvQty(session, input, t, phone);
      case "EV_CONFIRM":
        return await handleEvConfirm(session, input, t, phone);
      case "MENU":
      default:
        return await handleMenu(session, input, t, phone);
    }
  } catch (err) {
    console.error("WHATSAPP BOT ERROR:", err);
    try {
      await t.send(phone, "⚠️ Something went wrong. Type *menu* to start over.");
    } catch (sendErr) {
      console.error("WHATSAPP BOT SEND ERROR:", sendErr);
    }
  }
}

/* ================= MAIN MENU ================= */
async function handleMenu(session, input, t, phone) {
  switch (input) {
    case "1": {
      const events = await Event.find({ status: "LIVE", date: { $gt: new Date() } })
        .sort("date")
        .limit(8)
        .lean();

      if (!events.length) {
        await setSession(session, "MENU", {});
        return t.send(
          phone,
          `😔 No upcoming events right now.\n\nNew events go live all the time — check back soon!\n\nType *menu* to go back.`,
        );
      }

      await setSession(session, "BROWSING", {
        eventIds: events.map((e) => String(e._id)),
      });
      return uiList(
        t,
        phone,
        `🔎 *Upcoming events*\n\nPick one to see details.`,
        "Events",
        events.map((e, i) => ({
          id: String(i + 1),
          title: e.title,
          description: `${fmtDate(e.date)}${e.city ? ` · ${e.city}` : ""} · ${fromPriceLabel(e)}`,
        })),
      );
    }

    case "2":
      await setSession(session, "TICKETS_EMAIL", {});
      return t.send(
        phone,
        `🎫 *My tickets*\n\nWhat email did you use when buying? I'll fetch your most recent tickets and resend the QR codes here.`,
      );

    case "3":
      if (session.organizerUser) {
        await setSession(session, "ORG_MENU", {});
        return showOrgMenu(t, phone);
      }
      await setSession(session, "ORG_EMAIL", {});
      return t.send(
        phone,
        `💼 *Organizer zone*\n\nWhat's your Tictify account email? We'll send a *6-digit code* there to verify it's really you.`,
      );

    case "4":
      await setSession(session, "MENU", {});
      return t.send(phone, helpText());

    default:
      /* unknown input → main menu (spec: any unrecognised text) */
      await setSession(session, "MENU", {});
      return showMainMenu(t, phone, session);
  }
}

/* ================= BROWSING → EVENT DETAIL ================= */
async function handleBrowsing(session, input, t, phone) {
  const ids = Array.isArray(session.data?.eventIds) ? session.data.eventIds : [];
  const idx = parseInt(input, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    return t.send(
      phone,
      `Please reply with a number from the list (1-${ids.length || 1}), or type *menu*.`,
    );
  }

  const event = await Event.findById(ids[idx - 1]).lean();
  const now = new Date();
  if (!event || event.status !== "LIVE" || new Date(event.date) <= now) {
    await setSession(session, "MENU", {});
    return t.send(
      phone,
      `😕 That event is no longer available.\n\nType *menu* to browse again.`,
    );
  }

  const tiers = event.ticketTypes || [];
  const tierLines = tiers.map((tier, i) => {
    const price = effectivePrice(tier, now);
    const label = price === 0 ? "Free" : fmtNaira(price);
    const eb = earlyBirdActive(tier, now)
      ? ` 🐤 EARLY BIRD (normally ${fmtNaira(tier.price)})`
      : "";
    const soldOut = tier.quantity - (tier.sold || 0) <= 0 ? " — ❌ SOLD OUT" : "";
    return `*${i + 1}.* ${tier.name} — ${label}${eb}${soldOut}`;
  });

  await setSession(session, "PICK_TIER", {
    eventId: String(event._id),
    eventTitle: event.title,
    tierNames: tiers.map((tier) => tier.name),
    tierPrices: tiers.map((tier) => effectivePrice(tier, now)),
  });

  const detail =
    `🎟️ *${event.title}*\n` +
    `📅 ${fmtDate(event.date)}\n` +
    `📍 ${event.location}${event.city ? `, ${event.city}` : ""}\n\n` +
    `*Tickets:*\n${tierLines.join("\n")}`;

  /* ≤3 tiers → tappable buttons; more → list */
  if (tiers.length <= 3) {
    return uiButtons(
      t,
      phone,
      `${detail}\n\nPick a ticket, or type *menu* to cancel.`,
      tiers.map((tier, i) => {
        const price = effectivePrice(tier, now);
        return {
          id: String(i + 1),
          title: `${tier.name} — ${price === 0 ? "Free" : fmtNaira(price)}`,
        };
      }),
    );
  }
  return uiList(
    t,
    phone,
    `${detail}\n\nPick a ticket, or type *menu* to cancel.`,
    "Tickets",
    tiers.map((tier, i) => {
      const price = effectivePrice(tier, now);
      return {
        id: String(i + 1),
        title: tier.name,
        description: `${price === 0 ? "Free" : fmtNaira(price)}${earlyBirdActive(tier, now) ? " 🐤 Early bird" : ""}`,
      };
    }),
  );
}

/* ================= PICK TIER → QUANTITY ================= */
async function handlePickTier(session, input, t, phone) {
  const names = Array.isArray(session.data?.tierNames) ? session.data.tierNames : [];
  const idx = parseInt(input, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > names.length) {
    return t.send(
      phone,
      `Please reply with a ticket number from the list (1-${names.length || 1}), or type *menu*.`,
    );
  }

  const unitPrice = Number(session.data?.tierPrices?.[idx - 1] ?? NaN);
  await setSession(session, "QTY", {
    ...session.data,
    tierName: names[idx - 1],
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : undefined,
  });
  return t.send(phone, `How many *${names[idx - 1]}* tickets would you like? (1-10)`);
}

/* ================= QUANTITY → NAME ================= */
async function handleQty(session, input, t, phone) {
  const qty = parseInt(input, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
    return t.send(phone, `Please send a number between *1* and *10*.`);
  }

  await setSession(session, "NAME", { ...session.data, qty });
  return t.send(phone, `Great! What's your *full name*? (it goes on the ticket)`);
}

/* ================= NAME → EMAIL ================= */
async function handleName(session, input, t, phone) {
  if (input.length < 3) {
    return t.send(phone, `Please send your full name (at least 3 characters).`);
  }

  await setSession(session, "EMAIL", { ...session.data, name: input });
  return t.send(
    phone,
    `📧 And your *email address*? Your ticket will be sent there too.`,
  );
}

/* ================= EMAIL → DISCOUNT (paid) / instant ticket (free) ================= */
async function handleEmail(session, input, t, phone) {
  const email = input.toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return t.send(
      phone,
      `Hmm, that doesn't look like a valid email. Try again (e.g. ada@gmail.com), or type *menu* to cancel.`,
    );
  }

  /* FREE tier: no fees, no discounts, no pay method — mint right away */
  if (session.data?.unitPrice === 0) {
    await setSession(session, "PAY_METHOD", { ...session.data, email });
    return createAndReply(session, t, phone, "link");
  }

  await setSession(session, "DISCOUNT", { ...session.data, email });
  return uiButtons(
    t,
    phone,
    `🏷️ Have a *discount code*? Send it now — or skip.`,
    [{ id: "skip", title: "⏭️ Skip" }],
  );
}

/* ================= DISCOUNT CODE (optional) ================= */
async function handleDiscount(session, input, t, phone) {
  const lower = input.toLowerCase();
  if (["skip", "no", "none"].includes(lower)) {
    await setSession(session, "PAY_METHOD", { ...session.data });
    return askPayMethod(session, t, phone);
  }

  /* Pre-validate (read-only) — the atomic claim happens at payment time */
  const code = input.toUpperCase();
  const d = await resolveDiscount(session.data?.eventId, code).catch(() => null);
  if (!d) {
    return uiButtons(
      t,
      phone,
      `❌ *${code}* isn't a valid code for this event (or it's exhausted).\n\nSend another code — or skip.`,
      [{ id: "skip", title: "⏭️ Skip" }],
    );
  }

  await setSession(session, "PAY_METHOD", {
    ...session.data,
    discountCode: d.code,
  });
  return askPayMethod(
    session,
    t,
    phone,
    `✅ Code *${d.code}* applied — ${d.percentOff}% off!\n\n`,
  );
}

/* ================= PAYMENT METHOD ================= */
async function askPayMethod(session, t, phone, prefix = "") {
  const d = session.data || {};
  return uiButtons(
    t,
    phone,
    `${prefix}💳 *How would you like to pay?*\n\n${d.qty} × ${d.tierName} — ${d.eventTitle}`,
    [
      { id: "1", title: "💳 Card / link" },
      { id: "2", title: "🏦 Bank transfer" },
    ],
  );
}

async function handlePayMethod(session, input, t, phone) {
  if (input === "1") return createAndReply(session, t, phone, "link");
  if (input === "2") return createAndReply(session, t, phone, "transfer");
  return askPayMethod(session, t, phone);
}

/* order breakdown shared by the link and transfer replies */
function breakdownText(d, result) {
  const lines = [
    `${result.quantity} × ${d.tierName} @ ${fmtNaira(result.unitPrice)} = ${fmtNaira(result.unitPrice * result.quantity)}`,
  ];
  if (result.discountAmount > 0) {
    lines.push(`Discount (${d.discountCode}): −${fmtNaira(result.discountAmount)}`);
  }
  lines.push(`Platform fee: ${fmtNaira(result.platformFee)}`);
  lines.push(`Processing fee: ${fmtNaira(result.processingFee)}`);
  lines.push(`*Total: ${fmtNaira(result.total)}*`);
  return lines.join("\n");
}

async function createAndReply(session, t, phone, payMethod) {
  const d = session.data || {};
  const params = {
    eventId: d.eventId,
    ticketType: d.tierName,
    quantity: d.qty,
    name: d.name,
    email: d.email,
    promoter: d.promoter,
    discountCode: d.discountCode,
    waPhone: phone, // QR lands back in this chat once payment confirms
  };

  let result = await createPaymentSession({ ...params, payMethod });

  /* Bank transfer unavailable → transparently retry as a payment link
     (fresh call = fresh reference). Never dead-end the guest. */
  let transferFellBack = false;
  if (!result.ok && result.transferUnavailable) {
    transferFellBack = true;
    result = await createPaymentSession({ ...params, payMethod: "link" });
  }

  if (!result.ok) {
    /* Invalid/exhausted discount at claim time → retry just that step */
    if (/discount/i.test(result.message || "")) {
      await setSession(session, "DISCOUNT", { ...d, discountCode: undefined });
      return uiButtons(
        t,
        phone,
        `❌ ${result.message}.\n\nSend another code — or skip.`,
        [{ id: "skip", title: "⏭️ Skip" }],
      );
    }
    await setSession(session, "MENU", {});
    return t.send(
      phone,
      `😕 Could not start the payment: ${result.message || "please try again"}.\n\nType *menu* to start over.`,
    );
  }

  await setSession(session, "MENU", {});

  /* FREE ticket — already minted; QR delivery to this chat fires
     inside createPaymentSession (waPhone path) */
  if (result.free) {
    return t.send(
      phone,
      `🎉 *You're in!*\n\n` +
        `Your FREE ticket for *${d.eventTitle}* is confirmed.\n` +
        `Reference: ${result.reference}\n\n` +
        `📧 It's on its way to ${d.email} — and your QR code is arriving right here too. See you there!`,
    );
  }

  /* BANK TRANSFER — dedicated account details, pay without leaving chat */
  if (result.transfer) {
    const expires = result.expiresAt
      ? `\n⏳ Valid until: ${new Date(result.expiresAt).toLocaleString("en-NG", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}\n`
      : "";
    return t.send(
      phone,
      `🏦 *Pay by bank transfer — ${d.eventTitle}*\n\n` +
        `${breakdownText(d, result)}\n\n` +
        `Transfer *exactly ${fmtNaira(result.total)}* to:\n\n` +
        `*${result.bankName || "Bank"}*\n` +
        `${result.accountNumber}\n` +
        `${result.accountName ? `Account name: ${result.accountName}\n` : ""}` +
        expires +
        `\nReference: ${result.reference}\n\n` +
        `The moment your transfer lands, your QR ticket arrives *right here* and by email. 🎟️`,
    );
  }

  /* PAYMENT LINK (card, USSD, etc.) */
  const prefix = transferFellBack
    ? `🏦 Bank transfer isn't available right now — here's your secure payment link instead.\n\n`
    : "";
  return t.send(
    phone,
    `${prefix}🧾 *Order summary — ${d.eventTitle}*\n\n` +
      `${breakdownText(d, result)}\n\n` +
      `👉 Pay securely with Paystack:\n${result.paymentUrl}\n\n` +
      `The moment payment confirms, your QR ticket will arrive *right here* and by email. 🎟️`,
  );
}

/* ================= MY TICKETS ================= */
async function handleTicketsEmail(session, input, t, phone) {
  const email = input.toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return t.send(
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
    return t.send(
      phone,
      `😕 No tickets found for *${email}*.\n\nDouble-check the email you used at checkout, or type *menu* to browse events.`,
    );
  }

  await t.send(
    phone,
    `🎫 Found ${tickets.length} ticket${tickets.length > 1 ? "s" : ""} — sending your QR code${tickets.length > 1 ? "s" : ""} now…`,
  );

  for (const tk of tickets) {
    const ev = tk.event || {};
    await t.sendImage(
      phone,
      `${backendUrl()}/api/tickets/qr/${tk.paymentRef}`,
      `🎟️ ${ev.title || "Event"}\n📅 ${ev.date ? fmtDate(ev.date) : "—"}\nRef: ${tk.paymentRef}\nShow this QR at the gate.`,
    );
  }

  return t.send(phone, `That's everything! Type *menu* for the main menu.`);
}

/* ================= ORGANIZER: LINK ACCOUNT (EMAIL) ================= */
async function handleOrgEmail(session, input, t, phone) {
  const email = input.toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return t.send(
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

  return t.send(
    phone,
    `🔐 If an organizer account exists for that email, we've sent it a *6-digit code*.\n\nReply with the code here to link this number. (It expires in 10 minutes.)`,
  );
}

/* ================= ORGANIZER: LINK ACCOUNT (OTP) ================= */
async function handleOrgOtp(session, input, t, phone) {
  if (!/^\d{6}$/.test(input)) {
    return t.send(
      phone,
      `Please send the *6-digit code* from your email, or type *menu* to cancel.`,
    );
  }

  if (!session.otpHash || !session.otpExpires || session.otpExpires < new Date()) {
    clearOtpFields(session);
    await setSession(session, "MENU", {});
    return t.send(
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
      return t.send(
        phone,
        `❌ Too many wrong attempts. Type *3* from the *menu* to start again.`,
      );
    }
    await session.save();
    return t.send(
      phone,
      `❌ Wrong code — ${left} attempt${left === 1 ? "" : "s"} left.`,
    );
  }

  /* Correct code → permanent link */
  session.organizerUser = new mongoose.Types.ObjectId(session.data.linkUserId);
  clearOtpFields(session);
  await setSession(session, "ORG_MENU", {});
  return showOrgMenu(
    t,
    phone,
    `✅ *Account linked!* This WhatsApp number is now connected to your organizer account.\n\n`,
  );
}

/* ================= ORGANIZER: SUBMENU ================= */
async function handleOrgMenu(session, input, t, phone) {
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

      return showOrgMenu(
        t,
        phone,
        `📊 *Your stats*\n\n` +
          `💰 Wallet balance: ${fmtNaira(wallet?.balance || 0)}\n` +
          `📈 Total earnings: ${fmtNaira(wallet?.totalEarnings || 0)}\n` +
          `🎫 Tickets sold: ${sales[0]?.ticketsSold || 0}\n` +
          `🧾 Sales revenue: ${fmtNaira(sales[0]?.revenue || 0)}\n\n`,
      );
    }

    case "2":
      return t.send(
        phone,
        `💸 *Withdrawals*\n\nFor your security, withdrawals happen on the Tictify dashboard and are protected by a *6-digit email code* — no money moves without it.\n\n👉 ${frontendUrl()}/organizer/withdraw`,
      );

    case "3":
      session.organizerUser = undefined;
      await setSession(session, "MENU", {});
      return t.send(
        phone,
        `🔓 Done — this WhatsApp number is no longer linked to your organizer account.\n\nType *menu* anytime.`,
      );

    case "4":
      await setSession(session, "EV_TITLE", {});
      return t.send(
        phone,
        `📝 *New event*\n\nWhat's the event *title*?\n\n(Type *menu* anytime to cancel.)`,
      );

    default:
      return showOrgMenu(t, phone);
  }
}

/* ================= ORGANIZER: CREATE EVENT ================= */
async function handleEvTitle(session, input, t, phone) {
  if (input.length < 3) {
    return t.send(phone, `Please send a title of at least 3 characters.`);
  }
  await setSession(session, "EV_DATE", { evTitle: input.slice(0, 120) });
  return t.send(
    phone,
    `📅 What *date* is it happening?\n\nSend it as YYYY-MM-DD or DD/MM/YYYY (e.g. 2026-09-01). Must be in the future.`,
  );
}

async function handleEvDate(session, input, t, phone) {
  const date = parseEventDate(input);
  if (!date) {
    return t.send(
      phone,
      `Hmm, I couldn't read that. Please send a *future* date as YYYY-MM-DD or DD/MM/YYYY (e.g. 2026-09-01).`,
    );
  }
  await setSession(session, "EV_LOCATION", {
    ...session.data,
    evDate: date.toISOString(),
  });
  return t.send(phone, `📍 Where is the *venue*? (e.g. Landmark Centre, VI)`);
}

async function handleEvLocation(session, input, t, phone) {
  if (input.length < 3) {
    return t.send(phone, `Please send the venue (at least 3 characters).`);
  }
  await setSession(session, "EV_CITY", {
    ...session.data,
    evLocation: input.slice(0, 160),
  });
  return t.send(phone, `🏙️ Which *city*? (e.g. Lagos)`);
}

async function handleEvCity(session, input, t, phone) {
  if (input.length < 2) {
    return t.send(phone, `Please send the city name.`);
  }
  await setSession(session, "EV_CATEGORY", {
    ...session.data,
    evCity: input.slice(0, 60),
  });
  return uiList(
    t,
    phone,
    `🎭 What *category* fits best?`,
    "Category",
    EVENT_CATEGORIES.map((c, i) => ({ id: String(i + 1), title: c })),
  );
}

async function handleEvCategory(session, input, t, phone) {
  const idx = parseInt(input, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > EVENT_CATEGORIES.length) {
    return t.send(
      phone,
      `Please pick a category number (1-${EVENT_CATEGORIES.length}).`,
    );
  }
  await setSession(session, "EV_TICKET_NAME", {
    ...session.data,
    evCategory: EVENT_CATEGORIES[idx - 1],
  });
  return t.send(
    phone,
    `🎟️ Name your *ticket type* (e.g. Regular, VIP).\n\n📌 One tier here — you can add more tiers on the website later.`,
  );
}

async function handleEvTicketName(session, input, t, phone) {
  if (input.length < 2) {
    return t.send(phone, `Please send a ticket name (e.g. Regular).`);
  }
  await setSession(session, "EV_PRICE", {
    ...session.data,
    evTicketName: input.slice(0, 60),
  });
  return t.send(phone, `💰 Ticket *price* in ₦? (send a number — 0 means free)`);
}

async function handleEvPrice(session, input, t, phone) {
  const price = Number(input.replace(/[₦,\s]/g, ""));
  if (!Number.isFinite(price) || price < 0 || price > 10_000_000) {
    return t.send(
      phone,
      `Please send the price as a plain number (e.g. 5000), or 0 for free.`,
    );
  }
  await setSession(session, "EV_QTY", {
    ...session.data,
    evPrice: Math.round(price),
  });
  return t.send(
    phone,
    `🎫 How many tickets are *available*? (this also sets capacity)`,
  );
}

async function handleEvQty(session, input, t, phone) {
  const qty = parseInt(input.replace(/[,\s]/g, ""), 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100000) {
    return t.send(phone, `Please send a number between 1 and 100,000.`);
  }

  const d = { ...session.data, evQty: qty };
  await setSession(session, "EV_CONFIRM", d);

  return uiButtons(
    t,
    phone,
    `📋 *Confirm your event*\n\n` +
      `*${d.evTitle}*\n` +
      `📅 ${fmtDate(new Date(d.evDate))} — starts 6:00 PM (adjust exact times on the website)\n` +
      `📍 ${d.evLocation}, ${d.evCity}\n` +
      `🎭 ${d.evCategory}\n` +
      `🎟️ ${d.evTicketName} — ${d.evPrice === 0 ? "Free" : fmtNaira(d.evPrice)} × ${qty} (capacity ${qty})\n\n` +
      `📌 It will be saved as a *DRAFT*. Banner upload and multi-tier tickets are managed on the website — add them there, then hit Publish.`,
    [
      { id: "1", title: "✅ Create" },
      { id: "2", title: "❌ Cancel" },
    ],
  );
}

async function handleEvConfirm(session, input, t, phone) {
  const d = session.data || {};

  if (input === "2") {
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(t, phone, `Okay, cancelled — nothing was created.\n\n`);
  }
  if (input !== "1") {
    return t.send(phone, `Tap ✅ Create or ❌ Cancel (or reply *1* / *2*).`);
  }

  const startDate = new Date(d.evDate);
  if (isNaN(startDate.getTime()) || startDate <= new Date()) {
    await setSession(session, "EV_DATE", { evTitle: d.evTitle });
    return t.send(
      phone,
      `⌛ That date is no longer valid. Please send the event date again (YYYY-MM-DD).`,
    );
  }

  /* Mirrors the web createEvent controller: status defaults to DRAFT,
     ticketTypes carry sold:0, category defaults to "Other", city
     trimmed, bannerFit "cover", affiliates off, percent 15. Banner is
     a placeholder until they upload a real one on the website. */
  const event = await Event.create({
    organizer: session.organizerUser,
    title: d.evTitle,
    description: `${d.evTitle} — full details coming soon.`,
    location: d.evLocation,
    date: startDate,
    endDate: new Date(startDate.getTime() + 6 * 60 * 60 * 1000),
    capacity: d.evQty,
    ticketTypes: [
      { name: d.evTicketName, price: d.evPrice, quantity: d.evQty, sold: 0 },
    ],
    status: "DRAFT",
    banner: `${frontendUrl()}/logo.png`,
    category: d.evCategory || "Other",
    city: String(d.evCity || "").trim(),
    bannerFit: "cover",
    affiliatesEnabled: false,
    affiliatePercent: 15,
  });

  await setSession(session, "ORG_MENU", {});
  return t.send(
    phone,
    `🎉 *Event created!*\n\n` +
      `*${event.title}* is saved as a *DRAFT*.\n\n` +
      `👉 ${frontendUrl()}/events/${event._id}\n\n` +
      `To start selling:\n` +
      `1. Log in at ${frontendUrl()} → *My Events*\n` +
      `2. Add your banner image (and extra ticket tiers if you need them)\n` +
      `3. Hit *Publish*\n\n` +
      `Type *menu* anytime.`,
  );
}
