import nodemailer from "nodemailer";

// ============================================
// EMAIL PROVIDER FACTORY
// Supports: Resend, SendGrid, Mailgun, SMTP
// ============================================

/* Placeholder values (e.g. "your_brevo_smtp_key") must count as NOT
   configured — otherwise a half-filled .env block sits in front of a
   working provider and every email burns a connection timeout first. */
function configured(...values) {
  return values.every(
    (v) => v && !String(v).toLowerCase().includes("your_"),
  );
}

/* Sender identity — must belong to a domain verified with the provider */
const FROM_EMAIL = process.env.EMAIL_FROM || "noreply@tictify.ng";
const FROM_NAME = process.env.EMAIL_FROM_NAME || "Tictify";

const providers = {
  resend: createResendProvider,
  mailtrap: createMailtrapProvider,
  infobip: createInfobipProvider,
  sendgrid: createSendGridProvider,
  mailgun: createMailgunProvider,
  smtp: createSMTPProvider,
};

/* Infobip Email API — backup provider.
   Needs INFOBIP_API_KEY + INFOBIP_BASE_URL (your personal
   subdomain, e.g. https://xxxxx.api.infobip.com); the sender
   domain must be verified in the Infobip dashboard. */
function createInfobipProvider() {
  const key = process.env.INFOBIP_API_KEY;
  const base = String(process.env.INFOBIP_BASE_URL || "").replace(/\/+$/, "");
  if (!configured(key, base)) return null;

  return {
    name: "Infobip",
    send: async ({ to, subject, html }) => {
      const form = new FormData();
      form.append("from", `${FROM_NAME} <${FROM_EMAIL}>`);
      form.append("to", to);
      form.append("subject", subject);
      form.append("html", html);

      const response = await fetch(`${base}/email/3/send`, {
        method: "POST",
        headers: { Authorization: `App ${key}` },
        body: form,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Infobip error: ${response.status} ${detail.slice(0, 140)}`);
      }
      return await response.json();
    },
  };
}

/* Mailtrap Email Sending (free tier ~150/day) — REST API.
   NOTE: this is the production "Email Sending" product, not the
   testing sandbox; the domain must be verified in Mailtrap.
   Accepts MAILTRAP_TOKEN or MAILTRAP_API_KEY. */
function createMailtrapProvider() {
  const token = process.env.MAILTRAP_TOKEN || process.env.MAILTRAP_API_KEY;
  if (!configured(token)) {
    return null;
  }

  return {
    name: "Mailtrap",
    send: async ({ to, subject, html }) => {
      const response = await fetch("https://send.api.mailtrap.io/api/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: { email: FROM_EMAIL, name: FROM_NAME },
          to: [{ email: to }],
          subject,
          html,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Mailtrap error: ${response.status} ${detail.slice(0, 140)}`,
        );
      }

      return await response.json();
    },
  };
}

function createResendProvider() {
  if (!configured(process.env.RESEND_API_KEY)) {
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
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
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
  if (!configured(process.env.SENDGRID_API_KEY)) {
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
  if (!configured(process.env.MAILGUN_API_KEY, process.env.MAILGUN_DOMAIN)) {
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
  if (
    !configured(
      process.env.SMTP_HOST,
      process.env.SMTP_USER,
      process.env.SMTP_PASS,
    )
  ) {
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
    // A dead SMTP host must fail fast so the chain can move on
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
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

/* =====================================================
   FAILOVER CHAIN
   Every configured provider is tried in order (the one
   named in EMAIL_PROVIDER first). A provider that fails
   — quota exhausted, auth error, network — is put on a
   10-minute cooldown so busy sends skip straight to the
   next healthy provider. sendEmail NEVER throws: it
   returns { success:false } when the whole chain fails,
   so callers can offer the download fallback.
===================================================== */

const COOLDOWN_MS = 10 * 60 * 1000;
const cooldowns = new Map(); // provider key → timestamp until which it's skipped

function getProviderChain() {
  const preferred = process.env.EMAIL_PROVIDER || "smtp";
  const order = [preferred, ...Object.keys(providers).filter((k) => k !== preferred)];

  const chain = [];
  for (const key of order) {
    const provider = providers[key]?.();
    if (provider) chain.push({ key, ...provider });
  }
  return chain;
}

// Backwards-compatible single-provider getter
function getProvider() {
  return getProviderChain()[0] || null;
}

export async function sendEmail({ to, subject, html }) {
  const chain = getProviderChain();

  if (chain.length === 0) {
    console.log(`📧 [NO PROVIDER] Email to ${to}: ${subject}`);
    return { success: false, message: "No email provider configured" };
  }

  const now = Date.now();
  const errors = [];

  // Hard deadlines: no single provider may hang the request, and the
  // whole chain answers within ~20s so guests aren't left waiting.
  const PER_PROVIDER_TIMEOUT_MS = 10_000;
  const CHAIN_DEADLINE = Date.now() + 20_000;
  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
      ),
    ]);

  // Healthy providers first, cooled-down ones as a last resort
  const healthy = chain.filter((p) => (cooldowns.get(p.key) || 0) <= now);
  const coolingDown = chain.filter((p) => (cooldowns.get(p.key) || 0) > now);

  for (const provider of [...healthy, ...coolingDown]) {
    if (Date.now() > CHAIN_DEADLINE) {
      errors.push("chain deadline reached");
      break;
    }
    try {
      const result = await withTimeout(
        provider.send({ to, subject, html }),
        PER_PROVIDER_TIMEOUT_MS,
      );
      cooldowns.delete(provider.key);
      console.log(`✅ [${provider.name}] Email sent to ${to}`);
      return { success: true, provider: provider.name, result };
    } catch (error) {
      cooldowns.set(provider.key, Date.now() + COOLDOWN_MS);
      errors.push(`${provider.name}: ${error.message}`);
      console.error(
        `❌ [${provider.name}] Failed (trying next provider):`,
        error.message,
      );
    }
  }

  console.error(`🚨 ALL EMAIL PROVIDERS FAILED for ${to} — ${errors.join(" | ")}`);
  return {
    success: false,
    message: "All email providers failed",
    errors,
  };
}

// Export for testing/debugging
export { providers, getProvider, getProviderChain };
