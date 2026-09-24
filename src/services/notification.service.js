import Notification from "../models/Notification.js";

/* Notifications are persisted first. Web push is an optional delivery
   channel; the in-app inbox remains the source of truth. */
export async function createNotification({
  recipientId,
  type = "SYSTEM",
  title,
  message,
  href = "/organizer/dashboard",
  dedupeKey,
}) {
  if (!recipientId || !title || !message) return null;

  const payload = {
    recipient: recipientId,
    type,
    title,
    message,
    href:
      typeof href === "string" && href.startsWith("/")
        ? href
        : "/organizer/dashboard",
  };

  if (!dedupeKey) return Notification.create(payload);

  return Notification.findOneAndUpdate(
    { recipient: recipientId, dedupeKey },
    { $setOnInsert: { ...payload, dedupeKey } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}
