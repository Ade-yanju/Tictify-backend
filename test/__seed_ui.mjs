/* Seeds one realistic LIVE event so UI screenshots show real content
   rather than empty states. Idempotent: re-running replaces it. */
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../src/models/User.js";
import Event from "../src/models/Event.js";
import { buildEventSlug } from "../src/utils/resolveEvent.js";

await mongoose.connect(process.env.MONGO_URI);

const EMAIL = "uiseed-organizer@example.com";
await Event.deleteMany({ title: "Amapiano Night: Lagos Edition" });
await User.deleteOne({ email: EMAIL });

const organizer = await User.create({
  name: "SABi Sounds",
  email: EMAIL,
  passwordHash: await bcrypt.hash("supersecret123", 12),
  role: "organizer",
  emailVerified: true,
  whatsapp: "2348012345678",
});

const start = new Date(Date.now() + 21 * 86400000);
const ev = await Event.create({
  title: "Amapiano Night: Lagos Edition",
  description:
    "Six hours of log drum and piano from Lagos and Johannesburg. Doors 8pm, first set 9pm sharp. Outdoor venue — dress for the weather, dance for the log drum.",
  date: start,
  endDate: new Date(start.getTime() + 6 * 3600 * 1000),
  location: "Muri Okunola Park, Victoria Island",
  city: "Lagos",
  capacity: 800,
  category: "Nightlife",
  status: "LIVE",
  organizer: organizer._id,
  banner:
    "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=1600&q=80",
  ticketTypes: [
    { name: "Early Bird", price: 7500, quantity: 150, sold: 150 },
    { name: "Regular", price: 12000, quantity: 500, sold: 213 },
    { name: "VIP Table (4)", price: 90000, quantity: 30, sold: 11 },
  ],
});
ev.slug = buildEventSlug(ev.title, ev._id);
await ev.save();

console.log("seeded event:", ev.slug);
console.log("url         : http://localhost:5173/events/" + ev.slug);
console.log("organizer   :", EMAIL, "/ supersecret123");
await mongoose.disconnect();
