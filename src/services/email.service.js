import nodemailer from "nodemailer";

/**
 * ===============================
 * EMAIL TRANSPORTER
 * ===============================
 */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * ===============================
 * SEND EMAIL (NAMED EXPORT)
 * ===============================
 */
export async function sendEmail({ to, subject, html }) {
  await transporter.sendMail({
    from: `"Tictify" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });
}
