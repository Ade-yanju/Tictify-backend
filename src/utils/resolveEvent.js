/* =====================================================
   EVENT URL RESOLUTION — one helper, used everywhere an
   event is fetched from a URL parameter.

   Public links used to be raw ObjectIds:
     /events/6a54e6031ac5969395dfe858
   They are now human/SEO readable:
     /events/amapiano-jersey-rave-95dfe858

   SLUG FORMAT
     slugify(title) + "-" + last 8 hex chars of the _id

   The id suffix is what makes the slug unique, so there is
   no unique index, no collision retry, and no risk of two
   events fighting over the same title.

   NEVER BREAK A SHARED LINK. Every link already in the wild
   is a bare ObjectId, and a renamed event leaves stale slugs
   in people's WhatsApp threads. So resolution tries, in order:

     1. a valid 24-hex ObjectId  → findById            (old links)
     2. exact { slug } match                            (current links)
     3. the trailing 8-hex suffix vs the tail of _id     (stale slugs)

   Only after all three miss is it a genuine 404.
===================================================== */

import mongoose from "mongoose";
import Event from "../models/Event.js";

/* The title part of a slug: lowercase, accent-free, emoji-free,
   every run of non-alphanumerics collapsed to a single hyphen,
   capped so a rambling title can't produce a 300-char URL. */
export function slugifyTitle(title, maxLength = 60) {
  const base = String(title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accent marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // emoji, punctuation, spaces → hyphen
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, ""); // the slice may have left a dangling hyphen

  return base || "event";
}

/* The 8-char tail of an ObjectId — the uniqueness half of a slug. */
export function idSuffix(id) {
  return String(id ?? "").slice(-8).toLowerCase();
}

/* Full slug for an event. The suffix never changes, which is why a
   retitled event's OLD slugs still resolve (step 3 above). */
export function buildEventSlug(title, id) {
  return `${slugifyTitle(title)}-${idSuffix(id)}`;
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const SUFFIX_RE = /-([0-9a-fA-F]{8})$/;

/**
 * Resolve an `/events/:id` style parameter to an Event document.
 * Accepts an ObjectId, a current slug, or a stale slug.
 *
 * @param {string} idOrSlug
 * @returns {Promise<import("mongoose").Document|null>}
 */
export async function findEventByIdOrSlug(idOrSlug) {
  const raw = String(idOrSlug ?? "").trim();
  if (!raw) return null;

  /* 1️⃣ Every link shared before slugs existed */
  if (OBJECT_ID_RE.test(raw)) {
    return Event.findById(raw);
  }

  /* 2️⃣ The slug exactly as it is stored today */
  const exact = await Event.findOne({ slug: raw });
  if (exact) return exact;

  /* 3️⃣ Stale slug — the title changed but the id suffix did not.
     Compared against the hex string of _id so a renamed event's old
     links keep working forever. Rare path, so the collection scan
     it costs is fine. */
  const match = raw.match(SUFFIX_RE);
  if (!match) return null;
  const suffix = match[1].toLowerCase();

  return Event.findOne({
    $expr: {
      $eq: [{ $substrBytes: [{ $toString: "$_id" }, 16, 8] }, suffix],
    },
  });
}

/* Same resolution, but returns only the _id (as an ObjectId) — for
   callers that just need something to match other collections on. */
export async function resolveEventId(idOrSlug) {
  const raw = String(idOrSlug ?? "").trim();
  if (OBJECT_ID_RE.test(raw)) return new mongoose.Types.ObjectId(raw);
  const event = await findEventByIdOrSlug(raw);
  return event?._id ?? null;
}

export default findEventByIdOrSlug;
