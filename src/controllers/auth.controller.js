import User from "../models/User.js";
import bcrypt from "bcryptjs";
import { sendEmail } from "../services/email.service.js";

export const register = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (role !== "organizer") {
      return res.status(403).json({
        message: "Only organizers can register",
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        message: "Email already registered",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      name,
      email,
      passwordHash,
      role,
    });

    // 📧 SEND WELCOME EMAIL (async, don't block response)
    sendEmail({
      to: email,
      subject: "Welcome to Tictify! 🎟️",
      html: `
        <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 32px;">
          <h1 style="color: #22F2A6; margin-bottom: 8px;">Welcome to Tictify, ${name}!</h1>
          <p style="color: #666; margin-bottom: 20px;">Your organizer account is ready to go.</p>

          <div style="background: white; padding: 24px; border-radius: 12px; margin: 24px 0;">
            <h3 style="color: #1a1a1a; margin-top: 0;">Next Steps:</h3>
            <ol style="color: #666; line-height: 1.8;">
              <li>Log in to your account</li>
              <li>Create your first event</li>
              <li>Add ticket tiers and pricing</li>
              <li>Share event link with guests</li>
              <li>Track sales in real-time</li>
            </ol>
          </div>

          <a href="${process.env.FRONTEND_URL}/login" style="display: inline-block; background: #22F2A6; color: #0F0618; padding: 12px 24px; border-radius: 999px; text-decoration: none; font-weight: 600; margin: 24px 0;">
            Login to Tictify
          </a>

          <p style="color: #999; font-size: 12px; margin-top: 32px;">
            © ${new Date().getFullYear()} Tictify. All rights reserved.
          </p>
        </div>
      `,
    }).catch(err => console.error("Welcome email failed:", err.message));

    return res.status(201).json({
      message: "Organizer account created successfully",
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    return res.status(500).json({
      message: "Registration failed",
    });
  }
};
import jwt from "jsonwebtoken";

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ message: "Login failed" });
  }
};
