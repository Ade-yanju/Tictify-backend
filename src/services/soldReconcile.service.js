/* =====================================================
   SOLD COUNTER RECONCILIATION — make the numbers come
   from the database instead of from a counter that can
   drift.

   Each ticket tier carries a `sold` counter, incremented by
   the payment paths (free checkout, Paystack callback,
   webhook). If any increment is ever missed — a crashed
   request between Payment.save() and event.save(), or a
   payment recovered later by the admin reconcile sweep —
   the counter drifts from reality. That breaks BOTH the
   number shown to guests AND the purchase guard, because
   availability.js mirrors the guard off the same counter.

   AUTHORITATIVE SOURCE = Payment documents:

     { event, ticketType, status: "SUCCESS" }
     Σ { $ifNull: ["$quantity", 1] }  grouped by $ticketType

   That matches `tier.sold` semantics exactly. A qty-2 order
   increments sold by 2 but creates ONE Ticket document with a
   bigger groupSize — so counting Ticket documents would
   undercount every group order. Payments, not tickets.

   Drift is corrected AND logged: a silent self-heal would hide
   a real bug in a payment path, so every correction warns with
   the event, tier, counter value and actual value.
===================================================== */

import mongoose from "mongoose";
import Event from "../models/Event.js";
import Payment from "../models/Payment.js";
import { buildEventSlug } from "../utils/resolveEvent.js";

/* Payments store `event` as an ObjectId; aggregate() does no casting,
   so a string id would silently match nothing (and zero every tier). */
function toObjectId(id) {
  return id instanceof mongoose.Types.ObjectId
    ? id
    : new mongoose.Types.ObjectId(String(id));
}

/**
 * Recount one event's tiers against its SUCCESS payments.
 * Mutates + saves the document only when something actually drifted.
 *
 * A tier with no SUCCESS payments is legitimately corrected DOWN to 0 —
 * that is the truth, not a failure mode. It is only ever reached when
 * the aggregation ran successfully; if the aggregation throws, this
 * throws before touching a single counter.
 *
 * @param {import("mongoose").Document} event  a full (non-lean) Event doc
 * @returns {Promise<{changed: boolean, drifts: Array<{tier:string, counter:number, actual:number}>}>}
 */
export async function reconcileEventSold(event) {
  if (!event?._id || !Array.isArray(event.ticketTypes)) {
    return { changed: false, drifts: [] };
  }

  const rows = await Payment.aggregate([
    { $match: { event: toObjectId(event._id), status: "SUCCESS" } },
    {
      $group: {
        _id: "$ticketType",
        sold: { $sum: { $ifNull: ["$quantity", 1] } },
      },
    },
  ]);

  /* Only reached when the aggregation resolved — an empty result here
     genuinely means "nobody has bought from this event". */
  const actualByTier = new Map(
    rows.map((r) => [String(r._id), Math.max(0, Number(r.sold) || 0)]),
  );

  /* ── Attribute each payment group to a tier ──────────────────────
     Payments store the tier NAME, so a rename (or a stray trailing
     space — real production data contains "Ticket ") leaves sales
     pointing at a name no tier has any more. Match exactly first,
     then fall back to a normalized match, but only when exactly one
     tier normalizes to that key (never guess between two). */
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const byNormalized = new Map();
  for (const tier of event.ticketTypes) {
    const key = norm(tier.name);
    byNormalized.set(key, byNormalized.has(key) ? null : tier.name); // null = ambiguous
  }

  const resolved = new Map(); // tier name → sold
  let orphanTotal = 0;
  const orphanNames = [];
  for (const [paidName, sold] of actualByTier) {
    let target = event.ticketTypes.some((t) => String(t.name) === paidName)
      ? paidName
      : byNormalized.get(norm(paidName)) || null;
    if (!target) {
      orphanTotal += sold;
      orphanNames.push(paidName);
      continue;
    }
    resolved.set(target, (resolved.get(target) || 0) + sold);
  }

  /* Sales we can't attribute to any current tier. Lowering counters now
     would hand back capacity that is genuinely sold, so only corrections
     that RAISE a counter are applied until the names are reconciled. */
  if (orphanTotal > 0) {
    console.error(
      `⚠️ SOLD RECONCILE — "${event.title}": ${orphanTotal} sold ticket(s) reference unknown tier name(s) ${JSON.stringify(orphanNames)}. Downward corrections skipped to prevent overselling.`,
    );
  }

  const drifts = [];
  for (const tier of event.ticketTypes) {
    const actual = resolved.get(tier.name) ?? 0;
    const counter = Math.max(0, Number(tier.sold) || 0);
    if (counter === actual) continue;
    // Never free up seats we can't fully account for
    if (orphanTotal > 0 && actual < counter) continue;
    drifts.push({ tier: tier.name, counter, actual });
    tier.sold = actual;
  }

  if (drifts.length > 0) {
    await event.save();
    for (const d of drifts) {
      console.warn(
        `⚖️ SOLD DRIFT — "${event.title}" / ${d.tier}: counter said ${d.counter}, payments say ${d.actual} (corrected)`,
      );
    }
  }

  return { changed: drifts.length > 0, drifts };
}

/* One sweep at a time — a slow pass must not overlap the next tick,
   same guard the payout queue uses. */
let sweeping = false;

/**
 * Sweep every event worth checking: everything LIVE, plus anything
 * touched in the last 30 days so recently-ENDED events settle correctly.
 * Backfills a missing `slug` in the same pass — one sweep, not two.
 */
export async function reconcileAllSold() {
  if (sweeping) return { skipped: true };
  sweeping = true;

  const startedAt = Date.now();
  let checked = 0;
  let corrected = 0;
  let slugged = 0;
  let failed = 0;

  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const events = await Event.find({
      $or: [{ status: "LIVE" }, { updatedAt: { $gte: cutoff } }],
    });

    for (const event of events) {
      checked += 1;
      try {
        const { changed } = await reconcileEventSold(event);
        if (changed) corrected += 1;

        /* Feature A backfill: pre-slug events get theirs here rather
           than from a one-off migration script. */
        if (!event.slug) {
          event.slug = buildEventSlug(event.title, event._id);
          await event.save();
          slugged += 1;
        }
      } catch (err) {
        failed += 1;
        console.error(
          `SOLD RECONCILE (${event?._id}):`,
          err?.message || err,
        );
      }
    }

    console.log(
      `🧮 Sold reconcile: ${checked} checked, ${corrected} corrected, ${slugged} slugs backfilled, ${failed} failed (${Date.now() - startedAt}ms)`,
    );
  } catch (err) {
    console.error("SOLD RECONCILE SWEEP ERROR:", err);
  } finally {
    sweeping = false;
  }

  return { checked, corrected, slugged, failed };
}

export default reconcileAllSold;
