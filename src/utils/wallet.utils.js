import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";

export async function creditOrganizerWallet({
  organizerId,
  grossAmount,
  reference,
}) {
  const platformFee = Math.round(grossAmount * 0.03) + 80;
  const netAmount = Math.max(grossAmount - platformFee, 0);

  let wallet = await Wallet.findOne({ organizer: organizerId });

  if (!wallet) {
    wallet = await Wallet.create({ organizer: organizerId });
  }

  wallet.balance += netAmount;
  wallet.totalEarnings += netAmount;
  await wallet.save();

  await WalletTransaction.create({
    organizer: organizerId,
    type: "CREDIT",
    amount: netAmount,
    reference,
    description: "Ticket sale revenue (after platform fee)",
  });

  return {
    netAmount,
    platformFee,
  };
}
