/* =====================================================
   TICKET AVAILABILITY — the single source of truth for
   what the UI is allowed to promise a guest.

   This MUST mirror the two guards in createPaymentSession
   (payment.controller.js) exactly, or a page will advertise
   a sale the server then refuses:

     tier guard   : tierRemaining = tier.quantity - (tier.sold || 0)
                    refused when tierRemaining < qty
     event guard  : totalSold = Σ ticketTypes[].sold
                    refused when totalSold + qty > event.capacity

   Both guards count TICKETS, not guests — a group ticket
   (groupSize 4) counts as ONE against both. So the number a
   buyer can actually take from a tier is:

     effectiveTierRemaining =
       max(0, min(tier.quantity - tier.sold, capacity - totalSold))

   ---------------------------------------------------------------
   MISSING / MALFORMED FIELDS
   The rule is "never promise more than the server allows, and never
   claim sold out when the server would happily sell". So we mirror
   how the guards behave on non-numbers rather than defaulting to 0:

   - sold missing/NaN      → 0. Same as `(t.sold || 0)` in the guard.
   - capacity missing/<=0  → UNBOUNDED, reported as capacity: null and
     remaining: null. `totalSold + qty > undefined` is false, so the
     server does NOT refuse; forcing remaining to 0 here would show a
     phantom "Sold out". Callers key the event-level line off
     `capacity != null` (see EventDetails) so nothing is rendered when
     capacity is unknown.
   - tier quantity missing/NaN → UNBOUNDED for that tier, for the same
     reason (`NaN < qty` is false → the guard passes). The tier then
     shows whatever the event capacity still allows.

   Every number returned is a non-negative integer; nothing is ever
   NaN, negative, or Infinity.

   ---------------------------------------------------------------
   PER-TIER vs EVENT-LEVEL — they answer different questions

   The per-tier numbers are the GUARD MIRROR: they say exactly what
   createPaymentSession will sell from that tier, and nothing here
   changes them.

   The event-level `remaining` is a DISPLAY figure — "how many
   tickets are still out there?" — and capacity alone answers that
   badly. An event can be declared with capacity 400 while its tiers
   only ever offer 250 (real example: AMAPIANO JERSEY RAVE). The
   capacity guard would happily allow a 400th sale, but there is no
   tier left to sell it from, so advertising "400 remaining" is a
   promise nothing can keep. So:

     event remaining = min(capacity - totalSold, Σ tier remaining)

   where "Σ tier remaining" is the sum of the UNCAPPED per-tier
   figures (quantity - sold). A tier with no declared quantity is
   unbounded, which makes the sum unbounded, and the event figure
   falls back to the capacity number — the only honest answer left.

   `soldOut` follows that combined figure: the event is out of stock
   the moment either the capacity or the tiers run dry.

   Capacity unknown stays exactly as before — capacity: null,
   remaining: null, soldOut: false — because callers key the whole
   event-level line off `capacity != null` and would otherwise start
   rendering a line the server can't stand behind.
===================================================== */

/* Non-negative integer, or 0 for anything unusable. */
function safeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/* A declared limit: a positive finite number, else Infinity
   ("no limit declared" — which is exactly how the server's
   comparisons behave against undefined/NaN). */
function safeLimit(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}

/**
 * @param {object} event  Event document or plain object
 * @returns {{
 *   capacity: number|null,
 *   totalSold: number,
 *   remaining: number|null,
 *   soldOut: boolean,
 *   tiers: Array<{name:string, quantity:number|null, sold:number,
 *                 remaining:number, soldOut:boolean}>
 * }}
 */
export function computeAvailability(event) {
  const ticketTypes = Array.isArray(event?.ticketTypes) ? event.ticketTypes : [];

  /* Event guard mirror */
  const totalSold = ticketTypes.reduce((sum, t) => sum + safeCount(t?.sold), 0);
  const capacityLimit = safeLimit(event?.capacity);
  const capacityKnown = Number.isFinite(capacityLimit);

  /* Room left under the event capacity. Unknown capacity => unbounded. */
  const eventRemaining = capacityKnown
    ? Math.max(0, capacityLimit - totalSold)
    : Infinity;

  /* Σ of the UNCAPPED per-tier room — how many tickets the tiers can
     still actually produce. One unbounded tier makes the sum
     unbounded. */
  let tierRemainingSum = 0;

  const tiers = ticketTypes.map((t) => {
    const quantityLimit = safeLimit(t?.quantity);
    const sold = safeCount(t?.sold);

    /* Tier guard mirror, then clamped by the event guard —
       whichever binds first is what the buyer actually gets. */
    const tierRemaining = Number.isFinite(quantityLimit)
      ? Math.max(0, quantityLimit - sold)
      : Infinity;
    tierRemainingSum += tierRemaining;
    const remaining = Math.max(0, Math.min(tierRemaining, eventRemaining));

    return {
      name: t?.name ?? "",
      quantity: Number.isFinite(quantityLimit) ? quantityLimit : null,
      sold,
      /* Both limits unknown => genuinely unbounded; report 0 rather than
         Infinity so JSON stays valid, but never mark it sold out. */
      remaining: Number.isFinite(remaining) ? remaining : 0,
      soldOut: Number.isFinite(remaining) ? remaining <= 0 : false,
    };
  });

  /* DISPLAY figure: never promise more than the tiers can produce.
     Unbounded tier sum => the capacity number is the only one left. */
  const combinedRemaining =
    ticketTypes.length > 0 && Number.isFinite(tierRemainingSum)
      ? Math.max(0, Math.min(eventRemaining, tierRemainingSum))
      : eventRemaining; // no tiers declared at all => nothing to derive from

  return {
    capacity: capacityKnown ? capacityLimit : null,
    totalSold,
    remaining: capacityKnown ? combinedRemaining : null,
    soldOut: capacityKnown ? combinedRemaining <= 0 : false,
    tiers,
  };
}

export default computeAvailability;
