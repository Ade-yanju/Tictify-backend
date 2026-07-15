import dotenv from "dotenv";
dotenv.config(); // safe no-op if already loaded; guards against ESM import-order races

/* =====================================================
   WHATSAPP CLOUD API — TRANSPORT LAYER
   Pure message sending. No bot logic lives here — the
   webhook controller can import this without ever
   touching the conversation brain (no circular imports).
===================================================== */

const GRAPH_BASE = "https://graph.facebook.com/v20.0";
const SEND_TIMEOUT_MS = 10_000;

/* Placeholder values (e.g. "your_whatsapp_token") count as NOT
   configured — same discipline as the email providers. */
function isReal(...values) {
  return values.every(
    (v) => v && !String(v).toLowerCase().includes("your_"),
  );
}

function readConfig() {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  return {
    accessToken,
    phoneNumberId,
    verifyToken,
    ok: isReal(accessToken, phoneNumberId, verifyToken),
  };
}

export const whatsappConfigured = readConfig().ok;

/* POST to the Cloud API. NEVER throws — a WhatsApp hiccup must
   never break payments, webhooks, or the bot loop. */
async function postMessage(payload) {
  const { accessToken, phoneNumberId, ok } = readConfig();
  if (!ok) {
    console.log(
      `📱 [WHATSAPP NOT CONFIGURED] would send: ${JSON.stringify(payload).slice(0, 200)}`,
    );
    return { success: false, message: "WhatsApp not configured" };
  }

  try {
    const timer = new Promise((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`WhatsApp send timed out after ${SEND_TIMEOUT_MS}ms`)),
        SEND_TIMEOUT_MS,
      );
      t.unref?.();
    });

    const res = await Promise.race([
      fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
      timer,
    ]);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `❌ WHATSAPP SEND FAILED (${res.status}):`,
        JSON.stringify(data).slice(0, 300),
      );
      return { success: false, status: res.status, error: data };
    }
    return { success: true, data };
  } catch (err) {
    console.error("❌ WHATSAPP SEND ERROR:", err.message);
    return { success: false, message: err.message };
  }
}

export async function sendText(to, body) {
  return postMessage({
    messaging_product: "whatsapp",
    to: String(to),
    type: "text",
    text: { body: String(body).slice(0, 4096) },
  });
}

export async function sendImage(to, imageUrl, caption) {
  return postMessage({
    messaging_product: "whatsapp",
    to: String(to),
    type: "image",
    image: {
      link: imageUrl,
      ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
    },
  });
}

/* ── Post-payment QR delivery (WhatsApp twin of emailTicketToGuest).
   Called fire-and-forget wherever a ticket is minted. Never throws. ── */
export async function deliverTicketToWhatsApp({ phone, eventTitle, reference }) {
  try {
    if (!phone || !whatsappConfigured) return { success: false };
    const backend =
      process.env.BACKEND_URL || "https://tictify-backend.onrender.com";

    await sendText(
      phone,
      `🎉 *Payment confirmed — you're going!*\n\n` +
        `Your ticket for *${eventTitle || "your event"}* is ready.\n` +
        `Reference: ${reference}\n\n` +
        `Your QR code is arriving right here ⬇️ (it's also in your email).`,
    );
    return await sendImage(
      phone,
      `${backend}/api/tickets/qr/${reference}`,
      "Your entry QR — show this at the gate 🎟️",
    );
  } catch (err) {
    console.error("WHATSAPP TICKET DELIVERY ERROR:", err.message);
    return { success: false, message: err.message };
  }
}
