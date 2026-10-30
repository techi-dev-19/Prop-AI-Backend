# Bulk outreach (WhatsApp + Email, per-day schedule)

## Flow
1. Leads page -> **Import** -> upload CSV/Excel or paste contact data.
2. Choose channels (WhatsApp / Email), leads per day, send time (IST), start date and template.
3. `POST /api/campaigns/launch` creates the campaign and schedules eligible channel jobs.
4. `bulkWorker` sends one message at a time through Meta WhatsApp Cloud API or Brevo for email.
5. Sidebar and campaign pages receive live progress through Socket.IO.

## Email environment

```dotenv
BREVO_API_KEY=xkeysib-your-private-api-key
BREVO_FROM_EMAIL=campaigns@mail.yourcompany.com
BREVO_FROM_NAME=Agarwaal Homes
EMAIL_REPLY_TO=info@yourcompany.com
EMAIL_INBOUND_DOMAIN=replies.yourcompany.com
BREVO_WEBHOOK_SECRET=long-random-secret
BULK_EMAIL_INTERVAL_MS=2000
```

Verify the sender domain in Brevo before sending. For correlated replies, configure Brevo inbound parsing and a webhook at `https://YOUR_API_HOST/api/webhooks/brevo`; read `EMAIL_SETUP.md` for exact details.

## API
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/leads/import/parse-text` | Pasted text -> preview rows |
| POST | `/api/campaigns/launch` | Create campaign + schedule jobs |
| GET | `/api/campaigns` | Campaigns + channel-wise progress |
| POST | `/api/campaigns/:id/(pause\|resume\|cancel\|retry-failed)` | Controls |
| GET | `/api/outreach/summary` | Sidebar badges |
| GET | `/api/outreach/jobs?channel=&campaignId=&status=&page=` | Lead-wise status list |

## Notes
- Jobs are persisted in MongoDB and resume when the backend process returns.
- Each channel has its own rate limit and pause/retry policy.
- Email tracker rows record sending state, provider message ID, delivery events and replies.
- Reply tracking needs Brevo inbound parsing + webhook DNS/configuration; outgoing sending alone does not capture responses.
- Only send to contacts where you have an appropriate basis/consent. Implement and respect unsubscribe/suppression handling before sending marketing campaigns at scale.
