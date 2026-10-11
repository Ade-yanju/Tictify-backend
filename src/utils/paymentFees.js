/* Shared fee arithmetic for direct and installment payments. */
export const PLATFORM_FEE_FLAT = 50;
export const PLATFORM_FEE_RATE = 0.02;

export function computeProcessingFee(baseAmount) {
  const base = Math.max(0, Math.round(Number(baseAmount) || 0));
  let processingFee = Math.round(base * 0.015) + (base >= 2500 ? 100 : 0);
  return Math.min(processingFee, 2000);
}

export function computeFees(ticketPrice) {
  const subtotal = Math.max(0, Math.round(Number(ticketPrice) || 0));
  const platformFee =
    subtotal === 0 ? 0 : Math.round(PLATFORM_FEE_FLAT + subtotal * PLATFORM_FEE_RATE);
  const processingFee = computeProcessingFee(subtotal + platformFee);
  return {
    ticketPrice: subtotal,
    platformFee,
    processingFee,
    total: subtotal + platformFee + processingFee,
  };
}
