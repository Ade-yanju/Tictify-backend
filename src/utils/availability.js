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

  const tiers = ticketTypes.map((t) => {
    const quantityLimit = safeLimit(t?.quantity);
    const sold = safeCount(t?.sold);

    /* Tier guard mirror, then clamped by the event guard —
       whichever binds first is what the buyer actually gets. */
    const tierRemaining = Number.isFinite(quantityLimit)
      ? Math.max(0, quantityLimit - sold)
      : Infinity;
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

  return {
    capacity: capacityKnown ? capacityLimit : null,
    totalSold,
    remaining: capacityKnown ? eventRemaining : null,
    soldOut: capacityKnown ? eventRemaining <= 0 : false,
    tiers,
  };
}

export default computeAvailability;
