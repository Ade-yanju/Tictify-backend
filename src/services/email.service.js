import { sendEmail as sendViaProvider } from "./emailProviders.service.js";

// Main export - uses configured email provider
export async function sendEmail({ to, subject, html }) {
  try {
    return await sendViaProvider({ to, subject, html });
  } catch (error) {
    console.error("Email service error:", error.message);
    // Don't throw - allow app to continue even if email fails
    return { success: false, error: error.message };
  }
}
