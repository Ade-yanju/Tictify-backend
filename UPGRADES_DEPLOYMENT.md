# Production setup for the organizer upgrades

Add these variables to the backend service on Render:

```env
CRON_SECRET=generate-a-long-random-value
FRONTEND_URL=https://www.tictify.ng
BACKEND_URL=https://tictify-backend.onrender.com
WHATSAPP_REMINDER_TEMPLATE_NAME=event_reminder
WHATSAPP_REMINDER_TEMPLATE_LANGUAGE=en_US
```

Configure cron-job.org to call:

```text
GET https://tictify-backend.onrender.com/api/cron/event-reminders
```

Also schedule this endpoint every 15–30 minutes:

```text
GET https://tictify-backend.onrender.com/api/cron/installments
```

Send `x-cron-secret: <the same CRON_SECRET value>` with both requests. The
installment job sends the 24-hour and near-deadline balance reminders, then
releases reservations whose deadline has passed. The in-process sweep is a
fallback, but the external cron is required when the Render service is asleep.

Run it every 30 minutes and send the header `x-cron-secret` with the same
value as `CRON_SECRET`. The request processes upcoming reminders, WhatsApp
utility-template messages, post-event organizer reports, and guest feedback
follow-ups. Never put `CRON_SECRET` in frontend environment variables.

The WhatsApp template must be approved in Meta Business Manager and contain
one body variable for the event name (`{{1}}`).

## Installment refund policy

When an installment deadline passes, the implementation marks the reservation
`EXPIRED`, releases its reserved ticket inventory, and refunds every successful
installment charge in full to the original payment method. This includes the
platform fee and Paystack processing fees that were part of those charges.
Refund failures remain queued for retry by the same scheduled job.

Before launch, verify the complete Paystack sandbox flow: initial deposit,
partial balance payment, final balance payment and QR creation, duplicate
webhook/callback delivery, abandoned payment, deadline expiry, and event
cancellation.
