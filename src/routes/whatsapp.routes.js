import express from "express";
import crypto from "crypto";
import { sendText, sendImage } from "../services/whatsapp.service.js";
import { handleIncoming } from "../services/whatsappBot.service.js";

const router = express.Router();

/* =====================================================
   META VERIFICATION HANDSHAKE (GET)
   Meta calls this once when the webhook URL is saved.
===================================================== */
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === "subscribe" && verifyToken && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* =====================================================
   INCOMING MESSAGES (POST)
   ACK with 200 IMMEDIATELY — Meta retries non-200s
   aggressively — then process asynchronously.
   Raw body is mounted in index.js (before express.json)
   so the X-Hub-Signature-256 HMAC can be verified.
===================================================== */
router.post("/webhook", (req, res) => {
  res.sendStatus(200);

  try {
    const raw = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}));

    /* Optional HMAC check — only when Meta signs AND we hold the secret */
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    const signature = req.headers["x-hub-signature-256"];
    if (
      signature &&
      appSecret &&
      !String(appSecret).toLowerCase().includes("your_")
    ) {
      const expected =
        "sha256=" +
        crypto.createHmac("sha256", appSecret).update(raw).digest("hex");
      const a = Buffer.from(String(signature));
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.error("❌ WhatsApp webhook signature mismatch — ignored");
        return;
      }
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return; // not JSON — nothing to do
    }

    /* Guard every level — statuses/read receipts have no messages[] */
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message?.from) return;

    let text = "";
    if (message.type === "text") {
      text = message.text?.body || "";
    } else if (message.type === "interactive") {
      /* button/list replies: their id (or title) doubles as the input */
      text =
        message.interactive?.button_reply?.id ||
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.id ||
        message.interactive?.list_reply?.title ||
        "";
    } else if (message.type === "button") {
      text = message.button?.payload || message.button?.text || "";
    }

    handleIncoming(message.from, text, { send: sendText, sendImage }).catch(
      (err) => console.error("WHATSAPP BOT DISPATCH ERROR:", err),
    );
  } catch (err) {
    console.error("WHATSAPP WEBHOOK ERROR:", err);
  }
});

export default router;
