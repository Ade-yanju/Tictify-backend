export function effectivePrice(tier, at = new Date()) {
  if (
    tier &&
    tier.earlyBirdPrice != null &&
    tier.earlyBirdPrice >= 0 &&
    tier.earlyBirdUntil &&
    new Date(tier.earlyBirdUntil) > at
  ) {
    return Number(tier.earlyBirdPrice);
  }
  return Number(tier?.price || 0);
}
