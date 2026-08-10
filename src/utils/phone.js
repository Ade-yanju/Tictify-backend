/* =====================================================
   WHATSAPP NUMBER NORMALISATION

   One canonical form everywhere: digits only, country code
   included, no leading "+". That matters because the SAME human
   number arrives in three different shapes depending on the door
   they came through:

     web signup      "0801 234 5678"  /  "+234 801 234 5678"
     WhatsApp Cloud  "2348012345678"  (message.from — always E.164)

   Storing them raw would mean an organizer who signed up on the web
   could never be matched to the number messaging the bot, which is
   the whole point of the link.

   Nigeria (+234) is the default market, so a local 0-prefixed number
   is promoted to 234. Numbers that already carry a country code are
   left alone — this must not mangle a +44 or +1 organizer.
===================================================== */

const NG_CC = "234";

/* Nigerian mobile prefixes are 70/80/81/90/91… — i.e. after the
   trunk "0" the next digit is 7, 8 or 9. Used only to recognise a
   10-digit local number typed without its leading zero. */
const NG_MOBILE_HEAD = /^[789]/;

/**
 * @param {string|number} input  Anything a human or the API might send
 * @returns {string|null}  Digits-only E.164 without "+", or null if unusable
 */
export function normalizeWhatsApp(input) {
  if (input == null) return null;

  /* Strip "+", spaces, dashes, dots, brackets — everything but digits. */
  let digits = String(input).replace(/\D/g, "");
  if (!digits) return null;

  /* "00" international prefix (00234…) is the same as "+". */
  if (digits.startsWith("00")) digits = digits.slice(2);

  /* Local trunk form: 0801… (11 digits) → 234801… */
  if (digits.length === 11 && digits.startsWith("0")) {
    digits = NG_CC + digits.slice(1);
  } else if (digits.length === 10 && NG_MOBILE_HEAD.test(digits)) {
    /* Typed without the trunk zero: 801… → 234801… */
    digits = NG_CC + digits;
  }

  /* E.164 allows 15 digits max; below 10 nothing real fits. */
  if (!/^\d{10,15}$/.test(digits)) return null;

  /* A surviving leading zero means neither trunk-form branch above
     matched — e.g. a 10-digit typo like "0701234567". No country code
     starts with 0, so this can never equal the E.164 form the Cloud API
     sends. Reject it here rather than storing a number that would
     silently never link. */
  if (digits.startsWith("0")) return null;

  return digits;
}

/** Convenience: true when the input normalises to something usable. */
export function isValidWhatsApp(input) {
  return normalizeWhatsApp(input) !== null;
}

/* Display helper — "234 801 234 5678" reads better than a digit run
   in confirmation copy. Falls back to the raw value if unparseable. */
export function formatWhatsApp(input) {
  const n = normalizeWhatsApp(input);
  if (!n) return String(input ?? "");
  if (n.startsWith(NG_CC) && n.length === 13) {
    return `+${NG_CC} ${n.slice(3, 6)} ${n.slice(6, 9)} ${n.slice(9)}`;
  }
  return `+${n}`;
}

export default normalizeWhatsApp;
