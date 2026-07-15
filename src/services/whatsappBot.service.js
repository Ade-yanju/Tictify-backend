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
  downloadWhatsAppMedia,
} from "./whatsapp.service.js";
import { decodeQrFromImage } from "./qrDecode.service.js";
import {
  effectivePrice,
  createPaymentSession,
} from "../controllers/payment.controller.js";
import { resolveDiscount } from "../controllers/discount.controller.js";
import { performScan, transferTicket } from "../controllers/ticket.controller.js";

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
  { id: "3", title: "💼 Organizer zone", description: "Sales, scanning & event creation" },
  { id: "4", title: "❓ Help", description: "What this bot can do" },
  { id: "5", title: "🤝 Affiliate zone", description: "Your promo code, stats & share kit" },
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
  { id: "5", title: "🎫 Scan tickets", description: "Admit guests at the gate" },
];

const AFF_MENU_ROWS = [
  { id: "1", title: "📊 My stats", description: "Code, balance, earnings, sales" },
  { id: "2", title: "📣 Share kit", description: "Ready-to-forward promo message" },
  { id: "3", title: "🔓 Unlink", description: "Disconnect affiliate account" },
];

async function showAffMenu(t, phone, prefix = "") {
  return uiList(t, phone, `${prefix}🤝 *Affiliate zone*`, "Options", AFF_MENU_ROWS);
}

async function showOrgMenu(t, phone, prefix = "") {
  return uiList(t, phone, `${prefix}💼 *Organizer zone*`, "Options", ORG_MENU_ROWS);
}

function helpText() {
  return (
    `❓ *Tictify Help*\n\n` +
    `Here's what I can do:\n` +
    `🔎 *Browse events* — see what's on and buy tickets without leaving this chat (card, payment link, or bank transfer)\n` +
    `🎫 *My tickets* — resend your QR codes to this chat\n` +
    `💼 *Organizer zone* — sales & balance, create events, and *scan guest tickets at the gate* (photo or typed code)\n` +
    `🤝 *Affiliate zone* — your promo code, stats and a ready-to-forward share kit\n` +
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
export async function handleIncoming(phone, message, transport) {
  const t = transport || {};
  try {
    /* message is a plain string (typed/tapped input) OR
       { type: "image", imageId } for photos (gate scanning) */
    const isImage =
      message != null && typeof message === "object" && message.type === "image";
    const input = isImage ? "" : String(message ?? "").trim();

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
       organizerUser/affiliateUser links are permanent — only
       state/data reset. */
    const stale =
      session.updatedAt &&
      Date.now() - new Date(session.updatedAt).getTime() > SESSION_STALE_MS;
    if (stale && session.state !== "MENU") {
      clearOtpFields(session);
      await setSession(session, "MENU", {});
      await t.send(phone, "👋 Welcome back!");
      return showMainMenu(t, phone, session);
    }

    /* 📷 Photos only mean something at the gate scanner */
    if (isImage) {
      if (session.state === "SCAN" && session.organizerUser) {
        return await handleScanImage(session, message.imageId, t, phone);
      }
      return t.send(
        phone,
        `📷 Nice photo! If you're scanning guest tickets, open *Organizer zone* → *Scan tickets* first.\n\nType *menu* to get started.`,
      );
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
      (session.state === "ORG_MENU" ||
        session.state === "SCAN_PICK" ||
        session.state === "SCAN" ||
        session.state.startsWith("EV_")) &&
      !session.organizerUser
    ) {
      await setSession(session, "MENU", {});
      return showMainMenu(t, phone, session);
    }

    /* affiliate-only state needs a live link */
    if (session.state === "AFF_MENU" && !session.affiliateUser) {
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
      case "TICKETS_MENU":
        return await handleTicketsMenu(session, input, t, phone);
      case "TRANSFER_PICK":
        return await handleTransferPick(session, input, t, phone);
      case "TRANSFER_NAME":
        return await handleTransferName(session, input, t, phone);
      case "TRANSFER_EMAIL":
        return await handleTransferEmail(session, input, t, phone);
      case "TRANSFER_CONFIRM":
        return await handleTransferConfirm(session, input, t, phone);
      case "ORG_EMAIL":
        return await handleOrgEmail(session, input, t, phone);
      case "ORG_OTP":
        return await handleOrgOtp(session, input, t, phone);
      case "ORG_MENU":
        return await handleOrgMenu(session, input, t, phone);
      case "AFF_EMAIL":
        return await handleAffEmail(session, input, t, phone);
      case "AFF_OTP":
        return await handleAffOtp(session, input, t, phone);
      case "AFF_MENU":
        return await handleAffMenu(session, input, t, phone);
      case "SCAN_PICK":
        return await handleScanPick(session, input, t, phone);
      case "SCAN":
        return await handleScan(session, input, t, phone);
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

    case "5":
      if (session.affiliateUser) {
        await setSession(session, "AFF_MENU", {});
        return showAffMenu(t, phone);
      }
      await setSession(session, "AFF_EMAIL", {});
      return t.send(
        phone,
        `🤝 *Affiliate zone*\n\nWhat's your Tictify affiliate account email? We'll send a *6-digit code* there to verify it's really you.`,
      );

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

  if (!tickets.length) {
    await setSession(session, "MENU", {});
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

  /* Remember the proven owner + this ticket set so they can transfer one.
     The email they just looked up with IS the ownership proof. */
  await setSession(session, "TICKETS_MENU", {
    ownerEmail: email,
    tickets: tickets.map((tk) => ({
      ref: tk.paymentRef,
      title: tk.event?.title || "Event",
    })),
  });
  return uiButtons(
    t,
    phone,
    `That's everything! 🎟️\n\nGot the wrong person on a ticket? You can *transfer* it to someone else — they'll get a fresh QR and yours stops working.`,
    [{ id: "transfer", title: "🔁 Transfer a ticket" }],
  );
}

/* ================= TICKET TRANSFER (bot) ================= */
async function handleTicketsMenu(session, input, t, phone) {
  const lower = input.toLowerCase();
  if (lower !== "transfer") {
    await setSession(session, "MENU", {});
    return showMainMenu(t, phone, session);
  }

  const tickets = Array.isArray(session.data?.tickets) ? session.data.tickets : [];
  if (!tickets.length) {
    await setSession(session, "MENU", {});
    return showMainMenu(t, phone, session);
  }

  await setSession(session, "TRANSFER_PICK", { ...session.data });
  return uiList(
    t,
    phone,
    `🔁 *Transfer a ticket*\n\nWhich ticket do you want to hand over?`,
    "Tickets",
    tickets.map((tk, i) => ({
      id: String(i + 1),
      title: tk.title.slice(0, 24),
      description: `Ref ${tk.ref}`.slice(0, 72),
    })),
  );
}

async function handleTransferPick(session, input, t, phone) {
  const tickets = Array.isArray(session.data?.tickets) ? session.data.tickets : [];
  const idx = parseInt(input, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > tickets.length) {
    return t.send(
      phone,
      `Please reply with a ticket number from the list (1-${tickets.length || 1}), or type *menu*.`,
    );
  }
  const picked = tickets[idx - 1];
  await setSession(session, "TRANSFER_NAME", {
    ...session.data,
    transferRef: picked.ref,
    transferTitle: picked.title,
  });
  return t.send(
    phone,
    `👤 Who's the new holder? Send their *full name*.`,
  );
}

async function handleTransferName(session, input, t, phone) {
  if (input.trim().length < 2) {
    return t.send(phone, `Please send the new holder's full name (at least 2 characters).`);
  }
  await setSession(session, "TRANSFER_EMAIL", {
    ...session.data,
    transferName: input.trim(),
  });
  return t.send(phone, `📧 And their *email address*? The new QR ticket goes there.`);
}

async function handleTransferEmail(session, input, t, phone) {
  const email = input.toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return t.send(
      phone,
      `That doesn't look like a valid email. Try again, or type *menu* to cancel.`,
    );
  }
  const d = session.data || {};
  await setSession(session, "TRANSFER_CONFIRM", { ...d, transferEmail: email });
  return uiButtons(
    t,
    phone,
    `🔁 *Confirm transfer*\n\n` +
      `🎟️ ${d.transferTitle}\n` +
      `Ref: ${d.transferRef}\n\n` +
      `New holder: *${d.transferName}*\n` +
      `Email: ${email}\n\n` +
      `⚠️ Your current QR for this ticket will stop working immediately.`,
    [
      { id: "1", title: "✅ Transfer" },
      { id: "2", title: "❌ Cancel" },
    ],
  );
}

async function handleTransferConfirm(session, input, t, phone) {
  const d = session.data || {};
  if (input === "2") {
    await setSession(session, "MENU", {});
    return t.send(phone, `Okay, cancelled — nothing was transferred.\n\nType *menu* anytime.`);
  }
  if (input !== "1") {
    return t.send(phone, `Tap ✅ Transfer or ❌ Cancel (or reply *1* / *2*).`);
  }

  /* Ownership proof = the email they looked their tickets up with */
  const result = await transferTicket({
    reference: d.transferRef,
    ownerEmail: d.ownerEmail,
    newName: d.transferName,
    newEmail: d.transferEmail,
  });

  await setSession(session, "MENU", {});

  if (!result.ok) {
    return t.send(
      phone,
      `😕 Couldn't transfer that ticket: ${result.message}.\n\nType *menu* to start over.`,
    );
  }

  return t.send(
    phone,
    `✅ *Ticket transferred!*\n\n` +
      `*${result.newName}* is now the holder of your *${result.eventTitle || "event"}* ticket.\n` +
      `📧 Their fresh QR is on its way to ${result.newEmail}.\n\n` +
      `Your old QR for this ticket no longer works. Type *menu* anytime.`,
  );
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

    case "5": {
      /* Gate scanner: pick one of THEIR events first */
      const events = await Event.find({
        organizer: session.organizerUser,
        status: "LIVE",
        endDate: { $gt: new Date() }, // upcoming + happening right now
      })
        .sort("date")
        .limit(10)
        .lean();

      if (!events.length) {
        return showOrgMenu(
          t,
          phone,
          `😔 You have no live events to scan for right now.\n\n`,
        );
      }

      await setSession(session, "SCAN_PICK", {
        scanEventIds: events.map((e) => String(e._id)),
      });
      return uiList(
        t,
        phone,
        `🎫 *Scan tickets*\n\nWhich event are you scanning for?`,
        "Events",
        events.map((e, i) => ({
          id: String(i + 1),
          title: e.title,
          description: fmtDate(e.date),
        })),
      );
    }

    default:
      return showOrgMenu(t, phone);
  }
}

/* ================= GATE SCANNER ================= */
async function handleScanPick(session, input, t, phone) {
  const ids = Array.isArray(session.data?.scanEventIds)
    ? session.data.scanEventIds
    : [];
  const idx = parseInt(input, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    return t.send(
      phone,
      `Please reply with an event number from the list (1-${ids.length || 1}), or type *menu*.`,
    );
  }

  /* Ownership re-checked here — scans stay scoped to THIS event */
  const event = await Event.findOne({
    _id: ids[idx - 1],
    organizer: session.organizerUser,
  }).lean();
  if (!event) {
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(t, phone, `😕 That event is no longer available.\n\n`);
  }

  await setSession(session, "SCAN", {
    scanEventId: String(event._id),
    scanEventTitle: event.title,
    scanCount: 0,
  });
  return t.send(
    phone,
    `🎫 *Scanner armed — ${event.title}*\n\n` +
      `📷 Send a *photo* of the guest's QR code, or *type* the code/reference printed under it.\n\n` +
      `Type *done* when you finish.`,
  );
}

async function runScanAttempt(session, code, t, phone) {
  const result = await performScan({
    code,
    eventId: session.data?.scanEventId, // always scoped to the picked event
    actingUser: { _id: session.organizerUser, role: "organizer" },
    clientScanId: crypto.randomBytes(12).toString("hex"), // fresh per tap
    source: "bot",
  });

  if (!result.admitted) {
    return t.send(phone, `❌ *DENIED* — ${result.message}`);
  }

  const count = (session.data?.scanCount || 0) + 1;
  await setSession(session, "SCAN", { ...session.data, scanCount: count });

  const groupLine =
    result.groupSize > 1
      ? `\n👥 Admits ${result.groupSize}: ${result.admittedCount} of ${result.groupSize} used`
      : "";
  return t.send(
    phone,
    `✅ *ADMITTED*${result.groupSize > 1 ? ` — guest ${result.admittedCount} of ${result.groupSize}` : ""}\n` +
      `👤 ${result.guestName}\n` +
      `🎟️ ${result.ticketType || "—"}${groupLine}\n\n` +
      `📊 Session: ${count} admitted`,
  );
}

async function handleScan(session, input, t, phone) {
  const lower = input.toLowerCase();
  if (["done", "stop", "exit", "finish"].includes(lower)) {
    const n = session.data?.scanCount || 0;
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(
      t,
      phone,
      `🏁 Scanner closed — ${n} guest${n === 1 ? "" : "s"} admitted this session.\n\n`,
    );
  }
  /* anything else typed in SCAN mode is a scan attempt */
  return runScanAttempt(session, input, t, phone);
}

async function handleScanImage(session, imageId, t, phone) {
  /* injectable for tests; real transport uses the Cloud API + jimp/jsqr */
  const download = t.downloadMedia || downloadWhatsAppMedia;
  const decode = t.decodeQr || decodeQrFromImage;

  const buffer = await download(imageId);
  if (!buffer || !buffer.length) {
    return t.send(
      phone,
      `😕 I couldn't download that photo — please send it again, or type the code printed under the QR.`,
    );
  }

  const code = await decode(buffer);
  if (!code) {
    return t.send(
      phone,
      `😕 Couldn't read a QR in that photo — try a closer, well-lit shot, or type the code printed under the QR.`,
    );
  }

  return runScanAttempt(session, code, t, phone);
}

/* ================= AFFILIATE: LINK ACCOUNT (EMAIL) ================= */
async function handleAffEmail(session, input, t, phone) {
  const email = input.toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return t.send(
      phone,
      `That doesn't look like an email. Try again, or type *menu* to cancel.`,
    );
  }

  /* affiliates by role — or ANY account that owns a promo code */
  const user = await User.findOne({
    email,
    $or: [
      { role: "affiliate" },
      { affiliateCode: { $exists: true, $nin: [null, ""] } },
    ],
  });

  if (user) {
    const otp = String(crypto.randomInt(100000, 1000000));
    session.otpHash = sha256(otp);
    session.otpExpires = new Date(Date.now() + OTP_TTL_MS);
    session.otpAttempts = 0;
    await setSession(session, "AFF_OTP", { linkUserId: String(user._id) });

    sendEmail({
      to: user.email,
      subject: `Your Tictify WhatsApp code: ${otp}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#f9fafb;border-radius:16px;">
          <h2 style="color:#1a1a1a;margin-top:0;">Link WhatsApp to your affiliate account</h2>
          <p style="color:#555;line-height:1.7;">Someone (hopefully you) asked to connect a WhatsApp number ending in
          <strong>····${String(phone).slice(-4)}</strong> to your Tictify affiliate account.</p>
          <div style="text-align:center;background:#fff;padding:18px;border-radius:12px;margin:16px 0;">
            <p style="margin:0 0 6px;color:#888;font-size:12px;">YOUR CODE (expires in 10 minutes)</p>
            <p style="margin:0;font-size:32px;font-weight:800;letter-spacing:8px;color:#1a1a1a;">${otp}</p>
          </div>
          <p style="color:#B00020;font-size:13px;line-height:1.7;"><strong>Didn't request this?</strong> Ignore this email —
          nothing happens without the code. If you're worried, change your password and contact tictify@gmail.com.</p>
        </div>
      `,
    }).catch((e) => console.error("WA affiliate OTP email failed:", e.message));
  } else {
    /* No enumeration: unknown emails walk the exact same path with an
       unmatchable code — wrong-code replies are indistinguishable. */
    session.otpHash = sha256(crypto.randomBytes(16).toString("hex"));
    session.otpExpires = new Date(Date.now() + OTP_TTL_MS);
    session.otpAttempts = 0;
    await setSession(session, "AFF_OTP", {});
  }

  return t.send(
    phone,
    `🔐 If an affiliate account exists for that email, we've sent it a *6-digit code*.\n\nReply with the code here to link this number. (It expires in 10 minutes.)`,
  );
}

/* ================= AFFILIATE: LINK ACCOUNT (OTP) ================= */
async function handleAffOtp(session, input, t, phone) {
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
      `⌛ That code has expired. Type *5* from the *menu* to start again.`,
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
        `❌ Too many wrong attempts. Type *5* from the *menu* to start again.`,
      );
    }
    await session.save();
    return t.send(
      phone,
      `❌ Wrong code — ${left} attempt${left === 1 ? "" : "s"} left.`,
    );
  }

  /* Correct code → permanent link (separate from any organizer link) */
  session.affiliateUser = new mongoose.Types.ObjectId(session.data.linkUserId);
  clearOtpFields(session);
  await setSession(session, "AFF_MENU", {});
  return showAffMenu(
    t,
    phone,
    `✅ *Account linked!* This WhatsApp number is now connected to your affiliate account.\n\n`,
  );
}

/* Self-heal: an affiliate without a promo code gets one minted —
   EXACTLY like GET /api/affiliates/me — so bot and web agree. */
async function ensureAffiliateCode(userId) {
  const user = await User.findById(userId);
  if (!user) return { user: null, code: null };
  let code = user.affiliateCode;
  if (!code) {
    const prefix =
      String(user.name || "").replace(/[^a-zA-Z]/g, "").slice(0, 6).toUpperCase() ||
      "AFF";
    code = `${prefix}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    await User.updateOne({ _id: user._id }, { affiliateCode: code });
  }
  return { user, code };
}

/* ================= AFFILIATE: SUBMENU ================= */
async function handleAffMenu(session, input, t, phone) {
  switch (input) {
    case "1": {
      const affId = new mongoose.Types.ObjectId(String(session.affiliateUser));
      const { user, code } = await ensureAffiliateCode(affId);
      if (!user) {
        session.affiliateUser = undefined;
        await setSession(session, "MENU", {});
        return showMainMenu(t, phone, session);
      }

      /* Same aggregations as GET /api/affiliates/me — numbers must
         match the web dashboard exactly. */
      const [wallet, sales] = await Promise.all([
        Wallet.findOne({ organizer: affId }).lean(),
        Payment.aggregate([
          { $match: { promoter: code, status: "SUCCESS" } },
          {
            $group: {
              _id: null,
              ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
              salesVolume: { $sum: "$organizerAmount" },
            },
          },
        ]),
      ]);

      return showAffMenu(
        t,
        phone,
        `📊 *Your affiliate stats*\n\n` +
          `🏷️ Promo code: *${code}*\n` +
          `💰 Balance: ${fmtNaira(wallet?.balance || 0)}\n` +
          `📈 Total earned: ${fmtNaira(wallet?.totalEarnings || 0)}\n` +
          `🎫 Tickets sold: ${sales[0]?.ticketsSold || 0}\n` +
          `🧾 Sales volume: ${fmtNaira(sales[0]?.salesVolume || 0)}\n\n`,
      );
    }

    case "2": {
      const { user, code } = await ensureAffiliateCode(session.affiliateUser);
      if (!user) {
        session.affiliateUser = undefined;
        await setSession(session, "MENU", {});
        return showMainMenu(t, phone, session);
      }

      const botDigits = String(process.env.WHATSAPP_BOT_NUMBER || "")
        .replace(/^\+/, "")
        .replace(/[\s-]/g, "");
      const waLink = /^\d{8,15}$/.test(botDigits)
        ? `https://wa.me/${botDigits}?text=${encodeURIComponent(`Hi! I want tickets ref ${code}`)}`
        : null;

      return t.send(
        phone,
        `📣 *Your share kit* — forward this to your people 👇\n\n` +
          `━━━━━━━━━━━━\n` +
          `🎟️ *Tickets to the hottest events — right on WhatsApp!*\n` +
          `Browse, pay by card or bank transfer, and your QR ticket lands in the chat.\n\n` +
          (waLink
            ? `Tap to start:\n${waLink}\n\n(or just send *ref ${code}* as your first message)\n`
            : `Message the Tictify WhatsApp bot and start with:\n*ref ${code}*\n`) +
          `━━━━━━━━━━━━\n\n` +
          `💡 Your web links work too — every event link you copy on your dashboard carries *${code}* automatically.`,
      );
    }

    case "3":
      session.affiliateUser = undefined;
      await setSession(session, "MENU", {});
      return t.send(
        phone,
        `🔓 Done — this WhatsApp number is no longer linked to your affiliate account.\n\nType *menu* anytime.`,
      );

    default:
      return showAffMenu(t, phone);
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
