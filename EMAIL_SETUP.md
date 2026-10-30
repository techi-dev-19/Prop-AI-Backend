# Brevo bulk email + inbound reply tracking

This project uses the Brevo transactional email API (`POST https://api.brevo.com/v3/smtp/email`) for queued bulk sends, password-reset emails, and manual replies. It does not use Gmail SMTP or Resend for outgoing messages.

## Backend environment variables

```dotenv
BREVO_API_KEY=xkeysib-your-private-api-key
BREVO_FROM_EMAIL=campaigns@mail.yourcompany.com
BREVO_FROM_NAME=Agarwaal Homes
EMAIL_REPLY_TO=info@yourcompany.com
EMAIL_INBOUND_DOMAIN=replies.yourcompany.com
BREVO_WEBHOOK_SECRET=generate-a-long-random-secret
EMAIL_REPLY_WINDOW_HOURS=72
BULK_EMAIL_INTERVAL_MS=2000
```

- Keep `BREVO_API_KEY` only in the backend environment. Never place it in a `VITE_` frontend variable or commit it to Git.
- Verify/authenticate the sender domain in Brevo and add only the DNS records Brevo displays. A sender address must be authorized in Brevo before production sending.
- `BREVO_FROM_EMAIL` is the address used as the sender. `BREVO_FROM_NAME` is the display name.
- `EMAIL_REPLY_TO` is the human-facing fallback reply address. For correlated in-dashboard replies, `EMAIL_INBOUND_DOMAIN` must be a dedicated receiving subdomain, different from the sending domain.
- Configure sending authentication (including the DNS records Brevo gives you) before increasing volume. Respect consent, unsubscribe requests, and the limits displayed in your Brevo account.

## In-dashboard replies (Brevo inbound parsing)

Sending an email and receiving the lead's reply are separate actions. The CRM uses a unique address such as `reply+<32-char-tracking-token>@replies.yourcompany.com` to correlate an inbound reply to a lead/campaign.

1. Authenticate the sending domain in Brevo.
2. Pick a dedicated receiving subdomain different from the sending domain, e.g. `replies.yourcompany.com`.
3. In the DNS provider for that receiving subdomain, add the Brevo inbound MX records exactly as shown in Brevo's inbound parsing documentation/dashboard. Brevo commonly specifies `inbound1.sendinblue.com` (priority 10) and `inbound2.sendinblue.com` (priority 20); confirm the current values in your account before adding them. Do not change the main domain's MX records if Globehost/Hostinger handles the normal mailbox.
4. In Brevo, create a **Transactional** webhook pointed to `https://YOUR_API_HOST/api/webhooks/brevo` for `sent`, `delivered`, `opened`, `click`, `softBounce`, `hardBounce`, `blocked`, `spam`, `invalid`, `deferred`, and `unsubscribed` events.
5. Create a separate **Inbound** webhook pointing to the same URL, set its domain to `replies.yourcompany.com`, and subscribe to `inboundEmailProcessed`.
6. Configure both webhook definitions with the custom header `X-PropAI-Webhook-Secret` containing the same long random value stored in `BREVO_WEBHOOK_SECRET`. Brevo supports custom webhook headers; if setting this through API, use its webhook `headers` field.
7. Deploy/restart the backend, send a test message to a mailbox you control, reply to it, and verify that `Email → Conversations` changes to Replied. Also verify delivered/bounce events in Email Details.

The endpoint validates the custom secret header before processing incoming webhook payloads. Do not expose the secret in frontend code. The inbound webhook payload includes parsed text/HTML body and recipient addresses. If the `reply+...` address is removed by forwarding, the backend attempts an RFC `In-Reply-To` fallback when available.

## Webhook URL

```text
https://YOUR_API_HOST/api/webhooks/brevo
```

## Troubleshooting

- **401 / webhook authentication error:** Ensure `X-PropAI-Webhook-Secret` exactly matches `BREVO_WEBHOOK_SECRET` on the server.
- **401/403 from the send API:** Check the Brevo API key and account access.
- **400 from the send API:** Confirm sender verification and that the recipient/subject/body are valid.
- **No send event updates:** Confirm the transactional webhook has the right events and can reach the public HTTPS URL.
- **Email sends but no reply appears:** Check receiving-domain MX records, the inbound webhook, the secret header, and that `EMAIL_INBOUND_DOMAIN` matches the receiving subdomain used in DNS.
- **Duplicate send risk:** API timeouts can make it unclear whether a provider accepted a message before the connection failed. Provider webhooks and local job/tracker records help trace sends, but the custom trace header is not a provider-side idempotency guarantee; manually inspect provider logs before replaying a batch after an ambiguous timeout.

## Application behavior

- Every queued campaign email has a persistent `EmailMessage` tracker row.
- `GET /api/email/status` returns safe setup status without exposing credentials.
- `GET /api/email/replies` returns a spreadsheet-like tracker including rows without replies.
- `GET /api/email/replies/:id` returns the thread; `POST /api/email/replies/:id/reply` sends a human reply via Brevo.
- `POST /api/webhooks/brevo` handles Brevo transactional events and inbound parsed replies.
- Historic emails sent by Gmail/Resend before this integration are not backfilled automatically.
- Use explicit consent-based contact lists and provide a clear unsubscribe mechanism before sending promotional campaigns at scale.
