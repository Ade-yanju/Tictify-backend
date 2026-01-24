import dotenv from "dotenv";
dotenv.config();

import express from "express";
import mongoose from "mongoose";
import cors from "cors";

import authRoutes from "./routes/auth.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import ticketRoutes from "./routes/ticket.routes.js";
import eventRoutes from "./routes/event.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import salesRoutes from "./routes/sales.routes.js";
import withdrawalRoutes from "./routes/withdrawal.routes.js";
import organizerRoutes from "./routes/organizer.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import adminWithdrawalRoutes from "./routes/admin.withdrawal.routes.js";

const app = express();

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/withdrawals", withdrawalRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/organizer", organizerRoutes);

app.use("/api/admin", adminRoutes);
app.use("/api/admin", adminWithdrawalRoutes);
const PORT = 5000;

await mongoose.connect(process.env.MONGO_URI);
console.log("MongoDB connected");

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
