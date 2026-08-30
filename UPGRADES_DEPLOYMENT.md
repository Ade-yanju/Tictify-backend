# Production setup for the organizer upgrades

Add these variables to the backend service on Render:

```env
CRON_SECRET=generate-a-long-random-value
FRONTEND_URL=https://www.tictify.ng
WHATSAPP_REMINDER_TEMPLATE_NAME=event_reminder
WHATSAPP_REMINDER_TEMPLATE_LANGUAGE=en_US
```

Configure cron-job.org to call:

```text
GET https://tictify-backend.onrender.com/api/cron/event-reminders
```

Run it every 30 minutes and send the header `x-cron-secret` with the same
value as `CRON_SECRET`. The request processes upcoming reminders, WhatsApp
utility-template messages, post-event organizer reports, and guest feedback
follow-ups. Never put `CRON_SECRET` in frontend environment variables.

The WhatsApp template must be approved in Meta Business Manager and contain
one body variable for the event name (`{{1}}`).
