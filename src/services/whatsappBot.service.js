import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import User from "../models/User.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";
import Payment from "../models/Payment.js";
import Withdrawal from "../models/Withdrawal.js";
import DiscountCode from "../models/DiscountCode.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import { sendEmail } from "./email.service.js";
import {
  renderButtonsAsText,
  renderListAsText,
  downloadWhatsAppMedia,
} from "./whatsapp.service.js";
import { decodeQrFromImage } from "./qrDecode.service.js";
import cloudinary, { cloudinaryConfigured } from "../config/cloudinary.js";
import {
  effectivePrice,
  createPaymentSession,
} from "../controllers/payment.controller.js";
import { transferFee } from "./paystack.service.js";
import { resolveDiscount } from "../controllers/discount.controller.js";
import { performScan, transferTicket } from "../controllers/ticket.controller.js";
import { buildEventSlug, findEventByIdOrSlug, findEventByShortCode } from "../utils/resolveEvent.js";
import { normalizeWhatsApp } from "../utils/phone.js";

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

/* 🎟️ Event deep link: "event <slug-or-code>". This is what a guest
   who tapped "Buy on WhatsApp" on a shared event arrives with, so it
   must win from ANY state and drop them straight on the tier picker —
   a guest who came for one specific event should never have to hunt
   for it in the browse list.

   The key must be CODE-SHAPED: a full slug ending in the 8-hex id tail,
   a bare 8-hex tail, or a 24-hex ObjectId. Matching any bare word here
   would hijack ordinary prose — "what event should i attend" would be
   answered with "that link looks old" instead of the menu. */
const EVENT_RE =
  /\bevent[ :]+((?:[A-Za-z0-9-]*-)?[0-9a-fA-F]{8}|[0-9a-fA-F]{24})\b/i;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const MIN_WITHDRAWAL = 500;
const MAX_WITHDRAWAL = 5_000_000;
const BANKS = [
  { code: "044", name: "Access Bank" },
  { code: "023", name: "Citibank Nigeria" },
  { code: "050", name: "Ecobank Nigeria" },
  { code: "070", name: "Fidelity Bank" },
  { code: "011", name: "First Bank of Nigeria" },
  { code: "214", name: "First City Monument Bank" },
  { code: "058", name: "Guaranty Trust Bank" },
  { code: "030", name: "Heritage Bank" },
  { code: "082", name: "Keystone Bank" },
  { code: "076", name: "Polaris Bank" },
  { code: "101", name: "Providus Bank" },
  { code: "221", name: "Stanbic IBTC Bank" },
  { code: "068", name: "Standard Chartered Bank" },
  { code: "232", name: "Sterling Bank" },
  { code: "100", name: "SunTrust Bank" },
  { code: "032", name: "Union Bank of Nigeria" },
  { code: "033", name: "United Bank For Africa" },
  { code: "215", name: "Unity Bank" },
  { code: "035", name: "Wema Bank" },
  { code: "057", name: "Zenith Bank" },
];

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
   text fallback via plain send — the bot never goes silent.

   NOTE on the double fallback: the real sendButtons/sendList in
   whatsapp.service.js ALREADY fall back to text internally and report
   { success:true, fellBack:true } when that text lands, so the guard
   below short-circuits and the guest never gets the same message twice.
   The extra send here only fires when the text send failed too — i.e.
   nothing was delivered at all — so it's a genuine last resort, not a
   duplicate. It also covers transports that DON'T self-fall-back
   (the test stubs, and any future custom transport). ── */
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
    `Buy event tickets right here on WhatsApp.\n\n` +
    `💡 Know the event? Just *type its name* to jump straight to it.`
  );
}

async function showMainMenu(t, phone, session) {
  return uiList(t, phone, menuBody(session?.data?.promoter), "Menu", MENU_ROWS);
}

const ORG_MENU_ROWS = [
  { id: "1", title: "📊 Balance & stats", description: "Wallet, earnings, tickets sold" },
  { id: "2", title: "📅 My events", description: "Publish, end, edit, discounts" },
  { id: "3", title: "💸 Withdraw", description: "OTP-protected payout to your bank" },
  { id: "4", title: "➕ Create event", description: "Set up a new event from chat" },
  { id: "5", title: "🎫 Scan tickets", description: "Admit guests at the gate" },
  { id: "6", title: "🔓 Unlink this number", description: "Disconnect this WhatsApp" },
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
    `⌨️ *Type an event name* — e.g. "afrobeats night" — to search and skip the list entirely\n` +
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

    /* 🎁 Promo attribution: "ref CODE" anywhere, from ANY state.
       Applied BEFORE the event deep link, not instead of it — an
       affiliate's share carries both ("event <slug> ref <code>"), and
       dropping either one would cost the affiliate their commission or
       send the guest to the wrong screen. setSession carries promoter
       across every later state hop on its own. */
    const refMatch = input.match(REF_RE);
    if (refMatch) {
      clearOtpFields(session);
      await setSession(session, "MENU", { promoter: refMatch[1].toUpperCase() });
    }

    /* 🎟️ Event deep link: jump a cold guest straight to the tickets */
    const eventMatch = input.match(EVENT_RE);
    if (eventMatch) {
      const key = eventMatch[1];
      const found =
        (await findEventByIdOrSlug(key)) || (await findEventByShortCode(key));
      const event = found ? found.toObject?.() ?? found : null;
      const live =
        event && event.status === "LIVE" && new Date(event.date) > new Date();

      if (live) {
        clearOtpFields(session);
        return showEventDetail(session, event, t, phone, "👋 *Welcome!*\n\n");
      }
      /* Dead or unknown link — say so plainly rather than dumping the
         guest on a menu that looks like the link silently did nothing */
      await setSession(session, "MENU", {});
      await t.send(
        phone,
        event
          ? `😕 *${event.title}* isn't on sale anymore.\n\nHere's what else is coming up 👇`
          : `😕 I couldn't find that event — the link may be old.\n\nHere's what's coming up 👇`,
      );
      return showMainMenu(t, phone, session);
    }

    if (refMatch) return showMainMenu(t, phone, session);

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
      if (session.state === "EV_BANNER" && session.organizerUser) {
        return await handleEvBannerImage(session, message.imageId, t, phone);
      }
      return t.send(
        phone,
        `📷 Nice photo! If you're scanning tickets or adding an event banner, open the right Organizer zone flow first.\n\nType *menu* to get started.`,
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
        session.state.startsWith("ORG_EVENTS") ||
        session.state.startsWith("ORG_EVENT") ||
        session.state.startsWith("ORG_DISC") ||
        session.state.startsWith("WD_") ||
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
      case "ORG_GATE":
        return await handleOrgGate(session, input, t, phone);
      case "ORG_REG_NAME":
        return await handleOrgRegName(session, input, t, phone);
      case "ORG_REG_EMAIL":
        return await handleOrgRegEmail(session, input, t, phone);
      case "ORG_EMAIL":
        return await handleOrgEmail(session, input, t, phone);
      case "ORG_OTP":
        return await handleOrgOtp(session, input, t, phone);
      case "ORG_MENU":
        return await handleOrgMenu(session, input, t, phone);
      case "ORG_EVENTS":
        return await handleOrgEvents(session, input, t, phone);
      case "ORG_EVENT_ACTION":
        return await handleOrgEventAction(session, input, t, phone);
      case "ORG_EVENT_EDIT":
        return await handleOrgEventEdit(session, input, t, phone);
      case "ORG_EVENT_EDIT_VALUE":
        return await handleOrgEventEditValue(session, input, t, phone);
      case "ORG_DISC_CODE":
        return await handleOrgDiscCode(session, input, t, phone);
      case "ORG_DISC_PERCENT":
        return await handleOrgDiscPercent(session, input, t, phone);
      case "ORG_DISC_USES":
        return await handleOrgDiscUses(session, input, t, phone);
      case "WD_AMOUNT":
        return await handleWdAmount(session, input, t, phone);
      case "WD_BANK":
        return await handleWdBank(session, input, t, phone);
      case "WD_ACCOUNT":
        return await handleWdAccount(session, input, t, phone);
      case "WD_NAME":
        return await handleWdName(session, input, t, phone);
      case "WD_OTP":
        return await handleWdOtp(session, input, t, phone);
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
      case "EV_BANNER":
        return await handleEvBanner(session, input, t, phone);
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
    case "1":
      return await showEventPage(session, t, phone, 0);

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
      /* Ask BEFORE touching any email, so registration is a branch the
         guest chooses — never a "that email wasn't found, want to sign
         up?" fallback, which would leak which emails have accounts. */
      await setSession(session, "ORG_GATE", {});
      return uiButtons(
        t,
        phone,
        `💼 *Organizer zone*\n\nDo you already sell tickets on Tictify?`,
        [
          { id: "1", title: "Yes, link my acct" },
          { id: "2", title: "No, sign me up" },
        ],
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

    default: {
      /* Unrecognised text at the menu is most often the name of an
         event the guest already has in mind, so try that before
         falling back to redisplaying the menu. */
      const hit = await searchEvents(input);
      if (hit) return showSearchResult(session, hit, input, t, phone);

      await setSession(session, "MENU", {});
      return showMainMenu(t, phone, session);
    }
  }
}

/* ================= BROWSE LIST (PAGED) =================
   WhatsApp interactive lists are hard-capped at 10 rows by the Cloud
   API (see sendList in whatsapp.service.js). The old code coped by
   asking for only 8 events — which silently hid every event after the
   8th, with nothing in the UI to say more existed.

   So: PAGE_SIZE rows of events plus one "More events" row, which keeps
   the whole list reachable while staying inside the 10-row ceiling.

   Numbering restarts at 1 on every page and `eventIds` holds only the
   CURRENT page, so the number a guest taps always lines up with what
   they can see. `evPage` remembers where they are. ── */
const EV_PAGE_SIZE = 9;
const EV_MORE_ID = String(EV_PAGE_SIZE + 1); // the "More events" row

function liveEventFilter() {
  return { status: "LIVE", date: { $gt: new Date() } };
}

/* One page of live events, oldest date first. Asks for one extra row
   beyond the page to learn whether a "More" affordance is warranted
   without paying for a second count query. */
async function showEventPage(session, t, phone, page) {
  const skip = page * EV_PAGE_SIZE;
  const batch = await Event.find(liveEventFilter())
    .sort("date")
    .skip(skip)
    .limit(EV_PAGE_SIZE + 1)
    .lean();

  const events = batch.slice(0, EV_PAGE_SIZE);
  const hasMore = batch.length > EV_PAGE_SIZE;

  if (!events.length) {
    /* Page 0 empty = genuinely nothing on. A later page coming back
       empty means events ended while the guest was reading, so send
       them back to page 0 rather than to a dead end. */
    if (page > 0) return showEventPage(session, t, phone, 0);
    await setSession(session, "MENU", {});
    return t.send(
      phone,
      `😔 No upcoming events right now.\n\nNew events go live all the time — check back soon!\n\nType *menu* to go back.`,
    );
  }

  await setSession(session, "BROWSING", {
    eventIds: events.map((e) => String(e._id)),
    evPage: page,
    evHasMore: hasMore,
  });

  const rows = events.map((e, i) => ({
    id: String(i + 1),
    title: e.title,
    description: `${fmtDate(e.date)}${e.city ? ` · ${e.city}` : ""} · ${fromPriceLabel(e)}`,
  }));
  if (hasMore) {
    rows.push({
      id: EV_MORE_ID,
      title: "➡️ More events",
      description: "Show the next page",
    });
  }

  const heading = page === 0 ? "🔎 *Upcoming events*" : `🔎 *Upcoming events* — page ${page + 1}`;
  return uiList(
    t,
    phone,
    `${heading}\n\nPick one to see details, or *type an event name* to search.`,
    "Events",
    rows,
  );
}

/* ================= BROWSING → EVENT DETAIL ================= */
async function handleBrowsing(session, input, t, phone) {
  const ids = Array.isArray(session.data?.eventIds) ? session.data.eventIds : [];
  const page = Number(session.data?.evPage) || 0;

  /* "More events" — only honoured when this page actually offered it,
     so the number can't be used to page past the end of the list. */
  if (input === EV_MORE_ID && session.data?.evHasMore) {
    return showEventPage(session, t, phone, page + 1);
  }

  const idx = parseInt(input, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    /* Not a row number — treat it as an event-name search before
       giving up, so "afrobeats" works the same here as at the menu. */
    const hit = await searchEvents(input);
    if (hit) return showSearchResult(session, hit, input, t, phone);

    return t.send(
      phone,
      `Please reply with a number from the list (1-${ids.length || 1})${
        session.data?.evHasMore ? ` or *${EV_MORE_ID}* for more events` : ""
      }, type an *event name* to search, or *menu*.`,
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

  return showEventDetail(session, event, t, phone);
}

/* ================= EVENT NAME SEARCH =================
   A guest who knows what they want shouldn't have to page through a
   list to find it — they can just type "afrobeats night".

   Returns one of:
     null                       nothing worth showing (caller falls back)
     { one: event }             a single confident match → jump straight in
     { many: [events] }         several matches → let them pick

   Deliberately conservative about what counts as a search term. Short
   or numeric input is rejected because those are almost always row
   numbers, OTP digits or stray taps, and hijacking them would break
   the state machine. Matching is on title and city only — never
   description, which would match far too loosely. ── */
const SEARCH_MIN_LEN = 3;
const SEARCH_MAX_RESULTS = EV_PAGE_SIZE;

function isSearchableTerm(input) {
  const s = String(input || "").trim();
  if (s.length < SEARCH_MIN_LEN) return false;
  if (/^\d+$/.test(s)) return false; // row number / OTP digits
  if (EMAIL_RE.test(s)) return false; // an email answers a prompt, not a search
  /* Deep-link commands have their own handlers and must not be eaten. */
  if (/^(event|ref)\b/i.test(s)) return false;
  if (["menu", "hi", "hello", "hey", "start", "help"].includes(s.toLowerCase())) return false;
  return true;
}

async function searchEvents(input) {
  if (!isSearchableTerm(input)) return null;

  const term = String(input).trim();
  const rx = new RegExp(escapeRegex(term), "i");
  const events = await Event.find({
    ...liveEventFilter(),
    $or: [{ title: rx }, { city: rx }],
  })
    .sort("date")
    .limit(SEARCH_MAX_RESULTS + 1)
    .lean();

  if (!events.length) return null;
  if (events.length === 1) return { one: events[0] };
  return { many: events.slice(0, SEARCH_MAX_RESULTS), term };
}

/* Render whatever searchEvents found. A single hit goes straight to the
   event detail — the guest already told us which one they meant. */
async function showSearchResult(session, hit, term, t, phone) {
  if (hit.one) {
    return showEventDetail(
      session,
      hit.one,
      t,
      phone,
      `🔎 Found *${hit.one.title}*.\n\n`,
    );
  }

  await setSession(session, "BROWSING", {
    eventIds: hit.many.map((e) => String(e._id)),
    evPage: 0,
    evHasMore: false, // a result set, not a page of the full list
  });
  return uiList(
    t,
    phone,
    `🔎 *${hit.many.length} events match "${term}"*\n\nPick one to see details.`,
    "Results",
    hit.many.map((e, i) => ({
      id: String(i + 1),
      title: e.title,
      description: `${fmtDate(e.date)}${e.city ? ` · ${e.city}` : ""} · ${fromPriceLabel(e)}`,
    })),
  );
}

/* ================= EVENT DETAIL → TIER PICKER =================
   Shared by two entry points: picking a number off the browse list,
   and the `event <code>` deep link a guest taps from a shared post.
   Both must land on exactly the same tier picker, so this lives in
   one place — the deep link is a shortcut INTO the funnel, never a
   second implementation of it.

   `prefix` lets the deep link greet a guest who arrived cold, since
   they never saw the main menu. */
async function showEventDetail(session, event, t, phone, prefix = "") {
  const now = new Date();
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
    `${prefix}🎟️ *${event.title}*\n` +
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

  /* ── Organic backfill ──
     This exact moment proves BOTH things at once: they own the email
     (the code was sent there) and they control this handset (the code
     came back from it). That's a stronger proof than the web form
     collects, so persist the number and stamp it verified.

     Existing organizers therefore backfill themselves just by linking —
     no migration, no separate prompt.

     If the number is already on ANOTHER account we leave the account
     untouched rather than stealing it: the chat link still works, but
     the number stays where it is, and we say so instead of failing
     silently. */
  let numberNote = "";
  const normalized = normalizeWhatsApp(phone);
  if (normalized) {
    try {
      const owner = await User.findOne({
        whatsapp: normalized,
        _id: { $ne: session.organizerUser },
      }).select("_id");

      if (owner) {
        numberNote =
          `\n\n⚠️ Note: this number is saved on a different Tictify account, ` +
          `so we didn't move it. Your events still work here.`;
      } else {
        await User.updateOne(
          { _id: session.organizerUser },
          { $set: { whatsapp: normalized, whatsappVerifiedAt: new Date() } },
        );
      }
    } catch (err) {
      /* Never let a backfill problem break the link the guest just
         completed — the link is the thing they asked for. */
      console.error("WA NUMBER BACKFILL FAILED:", err.message);
    }
  }

  await setSession(session, "ORG_MENU", {});
  return showOrgMenu(
    t,
    phone,
    `✅ *Account linked!* This WhatsApp number is now connected to your organizer account.${numberNote}\n\n`,
  );
}

/* ================= ORGANIZER: GATE (link vs register) ================= */
async function handleOrgGate(session, input, t, phone) {
  if (input === "1") {
    await setSession(session, "ORG_EMAIL", {});
    return t.send(
      phone,
      `💼 What's your Tictify account email? We'll send a *6-digit code* there to verify it's really you.`,
    );
  }
  if (input === "2") {
    await setSession(session, "ORG_REG_NAME", {});
    return t.send(
      phone,
      `🎉 *Let's get you set up!*\n\nFirst — what's your *name* (or your brand's name)? This is what guests see on your events.`,
    );
  }
  return uiButtons(
    t,
    phone,
    `Please pick one — or type *menu* to go back.`,
    [
      { id: "1", title: "Yes, link my acct" },
      { id: "2", title: "No, sign me up" },
    ],
  );
}

/* ================= ORGANIZER: REGISTER (NAME) ================= */
async function handleOrgRegName(session, input, t, phone) {
  const name = input.trim();
  if (name.length < 2 || name.length > 60) {
    return t.send(
      phone,
      `Please send a name between 2 and 60 characters, or type *menu* to cancel.`,
    );
  }
  await setSession(session, "ORG_REG_EMAIL", { regName: name });
  return t.send(
    phone,
    `Nice to meet you, *${name}*! 👋\n\nWhat's your *email address*? We'll send your dashboard login link there.`,
  );
}

/* ================= ORGANIZER: REGISTER (EMAIL → CREATE) =================
   Creates a real organizer account tied to THIS handset. No password is
   collected in chat (it would sit in their message history forever);
   instead we set an unguessable random one and email a set-password
   link, reusing the existing forgot-password machinery verbatim
   (resetTokenHash + resetTokenExp + the live /reset-password page).

   emailVerified is true because the only way to finish setup is to open
   the emailed link — that proves the address as well as an OTP would. */
async function handleOrgRegEmail(session, input, t, phone) {
  const email = input.toLowerCase().trim();
  if (!EMAIL_RE.test(email)) {
    return t.send(
      phone,
      `That doesn't look like an email. Try again, or type *menu* to cancel.`,
    );
  }

  const name = session.data?.regName || "Organizer";

  /* Existing email → do NOT create a duplicate. Send them down the link
     path instead. This is safe to state plainly: they told us they're
     signing up, so "you already have an account" is their own fact, not
     a probe of someone else's. */
  const existing = await User.findOne({ email }).select("_id");
  if (existing) {
    await setSession(session, "ORG_EMAIL", {});
    return t.send(
      phone,
      `📧 You already have a Tictify account with that email!\n\n` +
        `Send it again here and I'll email you a *6-digit code* to link this number to it.`,
    );
  }

  const normalized = normalizeWhatsApp(phone);
  if (!normalized) {
    await setSession(session, "MENU", {});
    return t.send(
      phone,
      `⚠️ I couldn't read this WhatsApp number. Please sign up at ${frontendUrl()}/register instead.`,
    );
  }

  /* One account per handset — otherwise bot linking is ambiguous. */
  const numberTaken = await User.findOne({ whatsapp: normalized }).select("_id");
  if (numberTaken) {
    await setSession(session, "ORG_EMAIL", {});
    return t.send(
      phone,
      `📱 This WhatsApp number is already on a Tictify account.\n\n` +
        `Send that account's *email* here and I'll link this chat to it.`,
    );
  }

  try {
    /* Random password nobody knows — the set-password email is the only
       way in. 32 random bytes, hashed with the same cost as signup. */
    const randomPassword = crypto.randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(randomPassword, 12);

    const user = await User.create({
      name,
      email,
      passwordHash,
      role: "organizer",
      emailVerified: true,
      whatsapp: normalized,
      whatsappVerifiedAt: new Date(), // created FROM this handset
    });

    /* Set-password link — same token fields the web flow validates. */
    const token = crypto.randomBytes(32).toString("hex");
    user.resetTokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");
    user.resetTokenExp = new Date(Date.now() + 60 * 60 * 1000); // 1h
    await user.save();

    const link = `${frontendUrl()}/reset-password?token=${token}`;
    sendEmail({
      to: email,
      subject: "Welcome to Tictify — set your password 🎟️",
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#f9fafb;border-radius:16px;">
          <h2 style="color:#1a1a1a;margin-top:0;">Welcome to Tictify, ${name}!</h2>
          <p style="color:#555;line-height:1.7;">Your organizer account was created from WhatsApp. Set a password to also manage your events on the web dashboard:</p>
          <p style="text-align:center;margin:24px 0;">
            <a href="${link}" style="background:#E8C96A;color:#080910;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:700;">Set my password</a>
          </p>
          <p style="color:#888;font-size:13px;line-height:1.7;">This link expires in 1 hour. You can keep using the WhatsApp bot either way — it's already linked to this account.</p>
        </div>
      `,
    }).catch((e) => console.error("WA signup email failed:", e.message));

    /* Link the chat immediately — they can work right now, password or
       not. That's the whole promise of signing up inside WhatsApp. */
    session.organizerUser = user._id;
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(
      t,
      phone,
      `✅ *You're in, ${name}!* Your organizer account is live and linked to this number.\n\n` +
        `📧 We emailed *${email}* a link to set your password for the web dashboard (optional — everything works here too).\n\n`,
    );
  } catch (err) {
    if (err?.code === 11000) {
      await setSession(session, "ORG_EMAIL", {});
      return t.send(
        phone,
        `That email was just registered. Send it again here to link this number to it.`,
      );
    }
    console.error("WA ORGANIZER SIGNUP ERROR:", err);
    await setSession(session, "MENU", {});
    return t.send(
      phone,
      `⚠️ Something went wrong creating your account. Please try again, or sign up at ${frontendUrl()}/register.`,
    );
  }
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
      return showOrganizerEvents(session, t, phone);

    case "3":
      await setSession(session, "WD_AMOUNT", {});
      return t.send(
        phone,
        `💸 *Withdraw funds*\n\nHow much do you want to withdraw? Minimum ${fmtNaira(MIN_WITHDRAWAL)}.\n\nSend the amount as a number, e.g. 25000.`,
      );

    case "6":
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

async function showOrganizerEvents(session, t, phone, prefix = "") {
  const events = await Event.find({ organizer: session.organizerUser })
    .sort("-createdAt")
    .limit(10)
    .lean();

  if (!events.length) {
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(t, phone, `${prefix}You do not have events yet.\n\n`);
  }

  await setSession(session, "ORG_EVENTS", {
    orgEventIds: events.map((event) => String(event._id)),
  });
  return uiList(
    t,
    phone,
    `${prefix}📅 *My events*\n\nPick an event to manage.`,
    "Events",
    events.map((event, i) => ({
      id: String(i + 1),
      title: String(event.title || "Untitled").slice(0, 24),
      description: `${event.status} · ${fmtDate(event.date)}`.slice(0, 72),
    })),
  );
}

async function loadOwnedOrgEvent(session) {
  const eventId = session.data?.orgEventId;
  if (!eventId) return null;
  return Event.findOne({
    _id: eventId,
    organizer: session.organizerUser,
  });
}

async function handleOrgEvents(session, input, t, phone) {
  const ids = Array.isArray(session.data?.orgEventIds) ? session.data.orgEventIds : [];
  const idx = parseInt(input, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    return t.send(phone, `Please reply with an event number (1-${ids.length || 1}), or type *menu*.`);
  }

  const event = await Event.findOne({
    _id: ids[idx - 1],
    organizer: session.organizerUser,
  }).lean();
  if (!event) return showOrganizerEvents(session, t, phone, `😕 Event not found.\n\n`);

  await setSession(session, "ORG_EVENT_ACTION", {
    orgEventId: String(event._id),
    orgEventTitle: event.title,
  });

  const sold = (event.ticketTypes || []).reduce((sum, tier) => sum + (tier.sold || 0), 0);
  return uiList(
    t,
    phone,
    `📅 *${event.title}*\n` +
      `Status: ${event.status}\n` +
      `Date: ${fmtDate(event.date)}\n` +
      `Tickets sold: ${sold}/${event.capacity}\n\n` +
      `What do you want to do?`,
    "Actions",
    [
      { id: "1", title: "Publish / make live" },
      { id: "2", title: "End event" },
      { id: "3", title: "Edit basics" },
      { id: "4", title: "Add discount code" },
      { id: "5", title: "View discount codes" },
      { id: "6", title: "Sales summary" },
    ],
  );
}

async function handleOrgEventAction(session, input, t, phone) {
  const event = await loadOwnedOrgEvent(session);
  if (!event) return showOrganizerEvents(session, t, phone, `😕 Event not found.\n\n`);

  switch (input) {
    case "1":
      if (new Date(event.endDate) <= new Date()) {
        event.status = "ENDED";
        await event.save();
        return showOrganizerEvents(session, t, phone, `⌛ This event has ended, so it cannot be published.\n\n`);
      }
      event.status = "LIVE";
      await event.save();
      return showOrganizerEvents(session, t, phone, `✅ *${event.title}* is now LIVE.\n\n`);

    case "2":
      event.status = "ENDED";
      await event.save();
      return showOrganizerEvents(session, t, phone, `🏁 *${event.title}* has been ended.\n\n`);

    case "3":
      await setSession(session, "ORG_EVENT_EDIT", session.data);
      return uiList(t, phone, `✏️ What do you want to edit?`, "Fields", [
        { id: "title", title: "Title" },
        { id: "description", title: "Description" },
        { id: "location", title: "Venue/location" },
        { id: "city", title: "City" },
        { id: "capacity", title: "Capacity" },
        { id: "affiliate", title: "Affiliate settings" },
      ]);

    case "4":
      await setSession(session, "ORG_DISC_CODE", session.data);
      return t.send(phone, `🏷️ Send the discount code, e.g. EARLY20.`);

    case "5": {
      const codes = await DiscountCode.find({ event: event._id }).sort("-createdAt").lean();
      const body = codes.length
        ? codes
            .map((code) => `${code.active ? "✅" : "⏸️"} *${code.code}* — ${code.percentOff}% off, ${code.uses}/${code.maxUses} used`)
            .join("\n")
        : "No discount codes yet.";
      return uiButtons(t, phone, `🏷️ *Discount codes*\n\n${body}`, [
        { id: "4", title: "➕ Add code" },
      ]);
    }

    case "6": {
      const sales = await Payment.aggregate([
        { $match: { event: event._id, status: "SUCCESS" } },
        {
          $group: {
            _id: null,
            ticketsSold: { $sum: { $ifNull: ["$quantity", 1] } },
            revenue: { $sum: "$organizerAmount" },
          },
        },
      ]);
      return t.send(
        phone,
        `📊 *Sales — ${event.title}*\n\n` +
          `🎫 Tickets sold: ${sales[0]?.ticketsSold || 0}\n` +
          `🧾 Revenue: ${fmtNaira(sales[0]?.revenue || 0)}\n\n` +
          `Type *menu* or go back through Organizer zone.`,
      );
    }

    default:
      return t.send(phone, `Please pick an action from the list, or type *menu*.`);
  }
}

async function handleOrgEventEdit(session, input, t, phone) {
  if (!["title", "description", "location", "city", "capacity", "affiliate"].includes(input)) {
    return t.send(phone, `Please pick one of the listed fields, or type *menu*.`);
  }
  await setSession(session, "ORG_EVENT_EDIT_VALUE", {
    ...session.data,
    editField: input,
  });
  if (input === "affiliate") {
    return t.send(phone, `Send affiliate setting as: on 15\n\nUse off to disable, or on plus commission percent 1-50.`);
  }
  return t.send(phone, `Send the new ${input}.`);
}

async function handleOrgEventEditValue(session, input, t, phone) {
  const event = await loadOwnedOrgEvent(session);
  if (!event) return showOrganizerEvents(session, t, phone, `😕 Event not found.\n\n`);
  if (["ENDED", "CANCELLED"].includes(event.status)) {
    return showOrganizerEvents(session, t, phone, `A ${event.status.toLowerCase()} event cannot be edited.\n\n`);
  }

  const field = session.data?.editField;
  if (field === "capacity") {
    const capacity = parseInt(input.replace(/[,\s]/g, ""), 10);
    const totalSold = event.ticketTypes.reduce((sum, tier) => sum + (tier.sold || 0), 0);
    if (!Number.isInteger(capacity) || capacity < Math.max(1, totalSold)) {
      return t.send(phone, `Capacity must be a number and cannot be below tickets already sold (${totalSold}).`);
    }
    event.capacity = capacity;
  } else if (field === "affiliate") {
    const lower = input.toLowerCase();
    if (lower === "off") {
      event.affiliatesEnabled = false;
    } else {
      const match = lower.match(/^on\s+(\d{1,2})$/);
      if (!match) return t.send(phone, `Send *off* or *on 15* where 15 is the commission percent.`);
      event.affiliatesEnabled = true;
      event.affiliatePercent = Math.min(50, Math.max(1, parseInt(match[1], 10)));
    }
  } else if (["title", "description", "location", "city"].includes(field)) {
    if (input.trim().length < 2) return t.send(phone, `Please send at least 2 characters.`);
    event[field] = input.trim().slice(0, field === "description" ? 1000 : 160);
  }

  await event.save();
  return showOrganizerEvents(session, t, phone, `✅ Event updated.\n\n`);
}

async function handleOrgDiscCode(session, input, t, phone) {
  const code = input.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) {
    return t.send(phone, `Code must be 2-20 letters, numbers, dashes or underscores.`);
  }
  await setSession(session, "ORG_DISC_PERCENT", { ...session.data, discountCode: code });
  return t.send(phone, `What percent off? Send a number from 1 to 90.`);
}

async function handleOrgDiscPercent(session, input, t, phone) {
  const percent = parseInt(input, 10);
  if (!Number.isInteger(percent) || percent < 1 || percent > 90) {
    return t.send(phone, `Percent off must be a whole number from 1 to 90.`);
  }
  await setSession(session, "ORG_DISC_USES", { ...session.data, percentOff: percent });
  return t.send(phone, `Maximum uses? Send a number, e.g. 100.`);
}

async function handleOrgDiscUses(session, input, t, phone) {
  const event = await loadOwnedOrgEvent(session);
  if (!event) return showOrganizerEvents(session, t, phone, `😕 Event not found.\n\n`);
  const maxUses = Math.min(10000, Math.max(1, parseInt(input, 10) || 100));
  try {
    await DiscountCode.create({
      event: event._id,
      organizer: session.organizerUser,
      code: session.data.discountCode,
      percentOff: session.data.percentOff,
      maxUses,
    });
  } catch (err) {
    if (err.code === 11000) {
      await setSession(session, "ORG_DISC_CODE", session.data);
      return t.send(phone, `That code already exists for this event. Send another code.`);
    }
    throw err;
  }
  return showOrganizerEvents(session, t, phone, `✅ Discount *${session.data.discountCode}* created.\n\n`);
}

async function handleWdAmount(session, input, t, phone) {
  const amount = Number(input.replace(/[₦,\s]/g, ""));
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    return t.send(phone, `Please send a whole amount, e.g. 25000.`);
  }
  if (amount < MIN_WITHDRAWAL || amount > MAX_WITHDRAWAL) {
    return t.send(phone, `Withdrawal must be between ${fmtNaira(MIN_WITHDRAWAL)} and ${fmtNaira(MAX_WITHDRAWAL)}.`);
  }
  const wallet = await Wallet.findOne({ organizer: session.organizerUser }).lean();
  if (!wallet || wallet.balance < amount) {
    return showOrgMenu(
      t,
      phone,
      `Insufficient wallet balance. Available: ${fmtNaira(wallet?.balance || 0)}\n\n`,
    );
  }
  await setSession(session, "WD_BANK", { amount });
  return uiList(
    t,
    phone,
    `🏦 Pick the receiving bank.`,
    "Banks",
    BANKS.map((bank, i) => ({
      id: String(i + 1),
      title: bank.name.slice(0, 24),
      description: `Code ${bank.code}`,
    })),
  );
}

async function handleWdBank(session, input, t, phone) {
  const idx = parseInt(input, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > BANKS.length) {
    return t.send(phone, `Please reply with a bank number from the list (1-${BANKS.length}).`);
  }
  await setSession(session, "WD_ACCOUNT", {
    ...session.data,
    bank: BANKS[idx - 1],
  });
  return t.send(phone, `Send the *10-digit account number*.`);
}

async function handleWdAccount(session, input, t, phone) {
  const accountNumber = input.replace(/\D/g, "");
  if (!/^\d{10}$/.test(accountNumber)) {
    return t.send(phone, `Account number must be exactly 10 digits.`);
  }
  await setSession(session, "WD_NAME", { ...session.data, accountNumber });
  return t.send(phone, `Send the *account name* exactly as it should appear.`);
}

async function handleWdName(session, input, t, phone) {
  const accountName = input.trim();
  if (accountName.length < 3) {
    return t.send(phone, `Account name is required.`);
  }

  const userId = session.organizerUser;
  const amount = Number(session.data?.amount || 0);
  const bank = session.data?.bank;
  const wallet = await Wallet.findOne({ organizer: userId });
  if (!wallet || wallet.balance < amount) {
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(t, phone, `Insufficient wallet balance. Available: ${fmtNaira(wallet?.balance || 0)}\n\n`);
  }

  const pending = await Withdrawal.findOne({ organizer: userId, status: "PENDING" });
  if (pending) {
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(t, phone, `You already have a pending withdrawal. Wait for it to be processed.\n\n`);
  }

  await Withdrawal.updateMany(
    { organizer: userId, status: "AWAITING_OTP" },
    { status: "EXPIRED" },
  );

  const fee = transferFee(amount);
  const netAmount = amount - fee;
  const otp = String(crypto.randomInt(100000, 1000000));
  const withdrawal = await Withdrawal.create({
    organizer: userId,
    amount,
    transferFee: fee,
    netAmount,
    bankDetails: {
      bankName: bank.name,
      bankCode: bank.code,
      accountNumber: session.data.accountNumber,
      accountName,
    },
    status: "AWAITING_OTP",
    otpHash: sha256(otp),
    otpExpires: new Date(Date.now() + OTP_TTL_MS),
    otpAttempts: 0,
  });

  const user = await User.findById(userId).select("email name").lean();
  sendEmail({
    to: user.email,
    subject: `Confirm your withdrawal — code ${otp}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:30px;background:#f9fafb;border-radius:16px;">
        <h2 style="color:#1a1a1a;margin-top:0;">Confirm your withdrawal</h2>
        <p style="color:#555;line-height:1.7;">Reply in WhatsApp with this code to confirm your payout.</p>
        <div style="background:#fff;padding:18px 22px;border-radius:12px;border-left:4px solid #E8C96A;margin:16px 0;">
          <p style="margin:4px 0;"><strong>You receive:</strong> ₦${netAmount.toLocaleString()}</p>
          <p style="margin:4px 0;"><strong>To:</strong> ${bank.name} ····${session.data.accountNumber.slice(-4)} (${accountName})</p>
        </div>
        <div style="text-align:center;background:#fff;padding:18px;border-radius:12px;margin:16px 0;">
          <p style="margin:0 0 6px;color:#888;font-size:12px;">YOUR CONFIRMATION CODE</p>
          <p style="margin:0;font-size:32px;font-weight:800;letter-spacing:8px;color:#1a1a1a;">${otp}</p>
        </div>
      </div>
    `,
  }).catch((err) => console.error("WA withdrawal OTP email failed:", err.message));

  await setSession(session, "WD_OTP", {
    withdrawalId: String(withdrawal._id),
    amount,
    netAmount,
  });
  const masked = user.email.replace(/^(..).*(@.*)$/, "$1•••$2");
  return t.send(
    phone,
    `🔐 We sent a 6-digit confirmation code to ${masked}.\n\n` +
      `Reply with it here to request ${fmtNaira(netAmount)} to ${bank.name} ····${session.data.accountNumber.slice(-4)}.`,
  );
}

async function handleWdOtp(session, input, t, phone) {
  if (!/^\d{6}$/.test(input)) {
    return t.send(phone, `Enter the 6-digit code from your email, or type *menu* to cancel.`);
  }
  const withdrawal = await Withdrawal.findOne({
    _id: session.data?.withdrawalId,
    organizer: session.organizerUser,
    status: "AWAITING_OTP",
  });
  if (!withdrawal) {
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(t, phone, `No withdrawal is awaiting confirmation.\n\n`);
  }
  if (withdrawal.otpExpires < new Date()) {
    withdrawal.status = "EXPIRED";
    await withdrawal.save();
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(t, phone, `Code expired. Start the withdrawal again.\n\n`);
  }
  if (withdrawal.otpAttempts >= OTP_MAX_ATTEMPTS) {
    withdrawal.status = "EXPIRED";
    await withdrawal.save();
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(t, phone, `Too many wrong attempts. Start the withdrawal again.\n\n`);
  }
  if (sha256(input) !== withdrawal.otpHash) {
    withdrawal.otpAttempts += 1;
    await withdrawal.save();
    return t.send(phone, `Wrong code — ${OTP_MAX_ATTEMPTS - withdrawal.otpAttempts} attempts left.`);
  }

  const wallet = await Wallet.findOneAndUpdate(
    { organizer: session.organizerUser, balance: { $gte: withdrawal.amount } },
    { $inc: { balance: -withdrawal.amount } },
    { new: true },
  );
  if (!wallet) {
    withdrawal.status = "EXPIRED";
    await withdrawal.save();
    await setSession(session, "ORG_MENU", {});
    return showOrgMenu(t, phone, `Insufficient balance — the request was cancelled.\n\n`);
  }

  withdrawal.status = "PENDING";
  withdrawal.otpHash = undefined;
  withdrawal.otpExpires = undefined;
  await withdrawal.save();

  await WalletTransaction.create({
    organizer: session.organizerUser,
    type: "DEBIT",
    amount: withdrawal.amount,
    reference: `WD-HOLD-${withdrawal._id}`,
    description: `Withdrawal — ₦${withdrawal.netAmount.toLocaleString()} to ${withdrawal.bankDetails.bankName} ····${withdrawal.bankDetails.accountNumber.slice(-4)} (₦${withdrawal.transferFee} bank transfer fee)`,
  });

  await setSession(session, "ORG_MENU", {});
  return showOrgMenu(
    t,
    phone,
    `✅ Withdrawal confirmed. You will receive ${fmtNaira(withdrawal.netAmount)} once processed.\n\n`,
  );
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
  await setSession(session, "EV_BANNER", d);
  return uiButtons(
    t,
    phone,
    `🖼️ Send the event *banner/flyer image* now, or skip and use the Tictify placeholder.`,
    [{ id: "skip", title: "Skip for now" }],
  );
}

function confirmEventPrompt(d) {
  return uiButtons(
    d.t,
    d.phone,
    `📋 *Confirm your event*\n\n` +
      `*${d.evTitle}*\n` +
      `📅 ${fmtDate(new Date(d.evDate))} — starts 6:00 PM (adjust exact times on the website)\n` +
      `📍 ${d.evLocation}, ${d.evCity}\n` +
      `🎭 ${d.evCategory}\n` +
      `🎟️ ${d.evTicketName} — ${d.evPrice === 0 ? "Free" : fmtNaira(d.evPrice)} × ${d.evQty} (capacity ${d.evQty})\n` +
      `🖼️ Banner: ${d.evBanner ? "uploaded" : "placeholder"}\n\n` +
      `📌 It will be saved as a *DRAFT*. You can publish it from this bot after creation.`,
    [
      { id: "1", title: "✅ Create" },
      { id: "2", title: "❌ Cancel" },
    ],
  );
}

async function uploadBannerBuffer(buffer) {
  if (!cloudinaryConfigured) return null;
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "tictify/banners", resource_type: "image" },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
    stream.end(buffer);
  });
  return result.secure_url;
}

async function handleEvBanner(session, input, t, phone) {
  if (!["skip", "no", "none"].includes(input.toLowerCase())) {
    return t.send(phone, `Please send a banner image, tap *Skip for now*, or type *menu*.`);
  }
  await setSession(session, "EV_CONFIRM", {
    ...session.data,
    evBanner: `${frontendUrl()}/logo.png`,
  });
  return confirmEventPrompt({ ...session.data, evBanner: `${frontendUrl()}/logo.png`, t, phone });
}

async function handleEvBannerImage(session, imageId, t, phone) {
  const download = t.downloadMedia || downloadWhatsAppMedia;
  const buffer = await download(imageId);
  if (!buffer || !buffer.length) {
    return t.send(phone, `I couldn't download that image. Please send it again, or type *skip*.`);
  }
  let url = null;
  try {
    url = await uploadBannerBuffer(buffer);
  } catch (err) {
    console.error("WA BANNER UPLOAD ERROR:", err.message);
  }
  if (!url) {
    return t.send(phone, `Image uploads are not configured right now. Type *skip* to continue with the placeholder.`);
  }
  await setSession(session, "EV_CONFIRM", { ...session.data, evBanner: url });
  return confirmEventPrompt({ ...session.data, evBanner: url, t, phone });
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
     a placeholder when the organizer skipped the WhatsApp banner upload. */
  const eventId = new mongoose.Types.ObjectId();
  const event = await Event.create({
    _id: eventId,
    slug: buildEventSlug(d.evTitle, eventId),
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
    banner: d.evBanner || `${frontendUrl()}/logo.png`,
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
      `To start selling, open *Organizer zone* → *My events* → choose this event → *Publish*.\n\n` +
      `You can still use the website later for advanced edits like extra ticket tiers and exact start/end times.\n\n` +
      `Type *menu* anytime.`,
  );
}
