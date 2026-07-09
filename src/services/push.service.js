/* =====================================================
   WEB PUSH — VAPID notifications
   Topics:
   - "events": guests who asked for new-event alerts
   - "sales":  organizers, scoped to their own sales
   Dead subscriptions (410/404) are pruned automatically.
===================================================== */
import webpush from "web-push";
import PushSubscription from "../models/PushSubscription.js";

const configured = Boolean(
  process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY,
);

if (configured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:support@tictify.ng",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  console.log("✅ Web Push configured");
} else {
  console.warn("⚠️  VAPID keys missing — push notifications disabled");
}

export const pushConfigured = configured;

async function sendToSubscriptions(subs, payload) {
  const body = JSON.stringify(payload);
  let sent = 0;

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
        );
        sent++;
      } catch (err) {
        // Expired/revoked subscription → prune it
        if (err.statusCode === 410 || err.statusCode === 404) {
          await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
        }
      }
    }),
  );

  return sent;
}

/* New event goes LIVE → tell everyone subscribed to event alerts */
export async function notifyNewEvent(event) {
  if (!configured) return 0;
  const subs = await PushSubscription.find({ topic: "events" }).limit(5000);
  if (!subs.length) return 0;

  return sendToSubscriptions(subs, {
    title: "New event on Tictify 🎉",
    body: `${event.title} — ${event.location}. Tickets are live!`,
    url: `/events/${event._id}`,
  });
}

/* Ticket sold → tell that event's organizer */
export async function notifyTicketSale({ organizerId, eventTitle, ticketType, amount }) {
  if (!configured || !organizerId) return 0;
  const subs = await PushSubscription.find({
    topic: "sales",
    organizer: organizerId,
  });
  if (!subs.length) return 0;

  return sendToSubscriptions(subs, {
    title: "💰 Ticket sold!",
    body: `${ticketType} · ${eventTitle}${amount ? ` · ₦${Number(amount).toLocaleString()}` : ""}`,
    url: "/organizer/dashboard",
  });
}
