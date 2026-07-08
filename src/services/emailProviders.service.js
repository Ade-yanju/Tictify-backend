import nodemailer from "nodemailer";

// ============================================
// EMAIL PROVIDER FACTORY
// Supports: Resend, SendGrid, Mailgun, SMTP
// ============================================

const providers = {
  resend: createResendProvider,
  sendgrid: createSendGridProvider,
  mailgun: createMailgunProvider,
  smtp: createSMTPProvider,
};

function createResendProvider() {
  if (!process.env.RESEND_API_KEY) {
    console.warn("⚠️  RESEND_API_KEY not configured");
    return null;
  }

  return {
    name: "Resend",
    send: async ({ to, subject, html }) => {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "noreply@tictify.ng",
          to,
          subject,
          html,
        }),
      });

      if (!response.ok) {
        throw new Error(`Resend error: ${response.statusText}`);
      }

      return await response.json();
    },
  };
}

function createSendGridProvider() {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn("⚠️  SENDGRID_API_KEY not configured");
    return null;
  }

  return {
    name: "SendGrid",
    send: async ({ to, subject, html }) => {
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: "noreply@tictify.ng", name: "Tictify" },
          subject,
          content: [{ type: "text/html", value: html }],
        }),
      });

      if (!response.ok) {
        throw new Error(`SendGrid error: ${response.statusText}`);
      }

      return { success: true };
    },
  };
}

function createMailgunProvider() {
  if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
    console.warn("⚠️  MAILGUN_API_KEY or MAILGUN_DOMAIN not configured");
    return null;
  }

  return {
    name: "Mailgun",
    send: async ({ to, subject, html }) => {
      const formData = new URLSearchParams();
      formData.append("from", "noreply@" + process.env.MAILGUN_DOMAIN);
      formData.append("to", to);
      formData.append("subject", subject);
      formData.append("html", html);

      const response = await fetch(
        `https://api.mailgun.net/v3/${process.env.MAILGUN_DOMAIN}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(
              `api:${process.env.MAILGUN_API_KEY}`
            ).toString("base64")}`,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        throw new Error(`Mailgun error: ${response.statusText}`);
      }

      return await response.json();
    },
  };
}

function createSMTPProvider() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.warn("⚠️  SMTP configuration incomplete");
    return null;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return {
    name: "SMTP",
    send: async ({ to, subject, html }) => {
      return await transporter.sendMail({
        from: `"Tictify" <${process.env.SMTP_USER}>`,
        to,
        subject,
        html,
      });
    },
  };
}

// Get active provider based on priority
function getProvider() {
  const priority = process.env.EMAIL_PROVIDER || "resend";
  const selectedProvider = providers[priority]?.();

  if (selectedProvider) {
    console.log(`✅ Using ${selectedProvider.name} for emails`);
    return selectedProvider;
  }

  // Fallback to any available provider
  for (const [key, factory] of Object.entries(providers)) {
    const provider = factory();
    if (provider) {
      console.log(`✅ Falling back to ${provider.name} for emails`);
      return provider;
    }
  }

  console.warn("⚠️  No email provider configured. Emails will be logged only.");
  return null;
}

// Export send function
export async function sendEmail({ to, subject, html }) {
  const provider = getProvider();

  if (!provider) {
    console.log(`📧 [NO PROVIDER] Email to ${to}: ${subject}`);
    return { success: false, message: "No email provider configured" };
  }

  try {
    const result = await provider.send({ to, subject, html });
    console.log(`✅ [${provider.name}] Email sent to ${to}`);
    return { success: true, provider: provider.name, result };
  } catch (error) {
    console.error(`❌ [${provider.name}] Failed to send to ${to}:`, error.message);
    throw error;
  }
}

// Export for testing/debugging
export { providers, getProvider };
