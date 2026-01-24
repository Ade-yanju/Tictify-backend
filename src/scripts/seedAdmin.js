import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import User from "../models/User.js";

dotenv.config();

async function seedAdmin() {
  await mongoose.connect(process.env.MONGO_URI);

  const exists = await User.findOne({ role: "admin" });
  if (exists) {
    console.log("Admin already exists");
    process.exit();
  }

  const passwordHash = await bcrypt.hash("Admin@123", 10);

  await User.create({
    name: "System Admin",
    email: "admin@tictify.com",
    passwordHash,
    role: "admin",
  });

  console.log("Admin seeded successfully");
  process.exit();
}

seedAdmin();
