import crypto from "crypto";
import mongoose from "mongoose";
import dotenv from "dotenv";
import AffiliateSignup from "../models/AffiliateSignup.js";
import User from "../models/User.js";

dotenv.config();

function makeAffiliateCode(name) {
  const prefix =
    String(name || "").replace(/[^a-zA-Z]/g, "").slice(0, 6).toUpperCase() ||
    "AFF";
  return `${prefix}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

async function repairAffiliateSignups() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  await mongoose.connect(process.env.MONGO_URI);

  const paidSignups = await AffiliateSignup.find({ status: "PAID" });
  let repaired = 0;
  let skipped = 0;

  for (const signup of paidSignups) {
    let user = await User.findOne({ email: signup.email });
    const affiliateCode = signup.affiliateCode || user?.affiliateCode || makeAffiliateCode(signup.name);

    if (!user) {
      user = await User.create({
        name: signup.name,
        email: signup.email,
        passwordHash: signup.passwordHash,
        role: "affiliate",
        affiliateCode,
        isActive: true,
        emailVerified: true,
      });
      repaired += 1;
    } else if (!user.affiliateCode) {
      user.affiliateCode = affiliateCode;
      if (user.role !== "admin" && user.role !== "organizer") {
        user.role = "affiliate";
      }
      user.emailVerified = true;
      await user.save();
      repaired += 1;
    } else {
      skipped += 1;
    }

    if (!signup.affiliateCode) {
      signup.affiliateCode = user.affiliateCode || affiliateCode;
      await signup.save();
    }
  }

  console.log(`Affiliate signup repair complete. Repaired: ${repaired}. Skipped: ${skipped}.`);
  await mongoose.disconnect();
}

repairAffiliateSignups()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("Affiliate signup repair failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
