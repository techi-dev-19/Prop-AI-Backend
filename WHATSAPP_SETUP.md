# PropAI — Meta WhatsApp Cloud API production setup

This backend uses the official Meta WhatsApp Cloud API. Unipile/Baileys is not used.

## 1. Required `.env`

```env
CLIENT_URL=https://YOUR-FRONTEND-DOMAIN
PORT=5000
MONGO_URI=YOUR_MONGODB_URI
GEMINI_API_KEY=YOUR_GEMINI_KEY

META_WHATSAPP_ACCESS_TOKEN=YOUR_WORKING_META_ACCESS_TOKEN
META_WHATSAPP_PHONE_NUMBER_ID=YOUR_PHONE_NUMBER_ID
META_WHATSAPP_BUSINESS_ACCOUNT_ID=YOUR_WABA_ID
META_WHATSAPP_API_VERSION=v26.0
META_WHATSAPP_VERIFY_TOKEN=YOUR_RANDOM_VERIFY_TOKEN
META_WHATSAPP_APP_SECRET=YOUR_META_APP_SECRET
META_WHATSAPP_DEFAULT_COUNTRY_CODE=91

# Required for proactive messages when the lead has not messaged you in the
# last 24 hours. Use the EXACT approved template name and language.
META_WHATSAPP_OPENING_TEMPLATE_NAME=YOUR_APPROVED_TEMPLATE
META_WHATSAPP_OPENING_TEMPLATE_LANGUAGE=en_US
META_WHATSAPP_OPENING_TEMPLATE_INCLUDE_LEAD_NAME=false

# Used when the lead already has an open 24h customer-service window.
META_WHATSAPP_OPENING_TEXT=Namaste sir, main Tamanna, Deific Digital se baat kar rahi hoon. Kya abhi 2 minute baat ho sakti hai?

# User that owns new inbound numbers that are not already in the CRM.
DEFAULT_LEAD_OWNER_ID=YOUR_BROKER_USER_ID

REFERRAL_ENABLED=true
REFERRAL_PERSON_NAME=Monica
REFERRAL_CONTACT_NUMBER=YOUR_MONICA_NUMBER

# Normally true. Set false only when this SAME Meta App's webhook callback
# is owned by n8n and n8n will forward events to PropAI.
META_WHATSAPP_AUTO_SUBSCRIBE=true

# Only needed for the n8n forwarding option described below.
META_WHATSAPP_FORWARD_SECRET=LONG_RANDOM_SECRET
```

## 2. Meta webhook

PropAI must be reachable from the public internet over HTTPS. `localhost:5000` cannot be used as Meta's production webhook callback.

Register:

```text
GET/POST https://YOUR-BACKEND-DOMAIN/api/whatsapp/webhook
```

In Meta App Dashboard → WhatsApp → Configuration → Webhook:

1. Callback URL = the URL above.
2. Verify Token = exactly the value of `META_WHATSAPP_VERIFY_TOKEN`.
3. Verify and save.
4. Subscribe to the `messages` field.

The backend also calls `POST /{WABA_ID}/subscribed_apps` at startup when `META_WHATSAPP_AUTO_SUBSCRIBE=true`. If this call fails, fix the token/WABA permissions before testing inbound messages.

## 3. Important: n8n and PropAI on the same WhatsApp number

The important question is whether n8n and PropAI use the **same Meta App** or two different Meta Apps.

### Case A — different Meta Apps

Both apps can be configured against the same WhatsApp Business Account as appropriate. Give the PropAI Meta App its own webhook URL and subscribe its `messages` field. n8n can keep its own webhook.

### Case B — the SAME Meta App

Do NOT blindly replace the n8n callback URL. Use one of these approaches:

**Recommended for PropAI-only AI replies:** move the Meta webhook callback to PropAI and disable the n8n reply workflow for this number.

**Keep n8n as the callback:** set:

```env
META_WHATSAPP_AUTO_SUBSCRIBE=false
META_WHATSAPP_FORWARD_SECRET=LONG_RANDOM_SECRET
```

Then add an n8n HTTP Request node after the incoming Meta event:

```text
POST https://YOUR-BACKEND-DOMAIN/api/whatsapp/webhook/forward
Header:
X-PropAI-Webhook-Secret: LONG_RANDOM_SECRET
Content-Type: application/json

Body: the original Meta webhook JSON
```

If n8n also sends its own AI reply while forwarding, the lead may receive duplicate replies. For PropAI to be the only AI responder, keep the n8n flow as an event forwarder only (or pause its response branch).

## 4. What the backend now does

### Lead added manually / CSV

1. Lead is normalized to international digits.
2. Conversation is created.
3. Backend first tries ordinary text. This succeeds only if Meta says the customer's 24h window is open.
4. If Meta returns error `131047`, backend automatically tries the approved opening template.
5. A message is recorded only after Meta accepts it.
6. Delivery/read/failed status updates are handled through the webhook.

### Customer replies

1. Meta sends the inbound event to PropAI.
2. Backend verifies the webhook signature when `META_WHATSAPP_APP_SECRET` is set.
3. Webhook messages are deduplicated by `wamid`.
4. Lead is found by WhatsApp number; an unknown number can be auto-created using `DEFAULT_LEAD_OWNER_ID`.
5. `lastInboundAt` is updated.
6. The message is marked read.
7. Gemini receives recent conversation history + current requirements + matching properties.
8. AI sends a normal WhatsApp text reply while the 24h window is open.
9. Outbound message is stored with its Meta message ID.
10. Meta delivery/read/failed status events update that message record.

### Outside the 24h window

Free-form text is not allowed by Meta. The backend does not try to bypass this. The opening template is used for a business-initiated re-engagement message.

## 5. Diagnostics endpoint

After login, call:

```text
GET /api/whatsapp/diagnostics
```

It verifies:
- Meta sender Phone Number ID
- WABA ID
- whether the configured Phone Number ID belongs to that WABA
- display phone number / verified name / quality rating

It never returns the access token or App Secret.

## 6. Recommended production test sequence

1. Deploy backend on HTTPS.
2. Configure `.env` and restart.
3. Confirm startup log says `Meta sender verified`.
4. Verify Meta webhook.
5. Confirm `messages` subscription.
6. Send `Hi` from a personal/test WhatsApp to the business number.
7. Confirm backend log: `Webhook message received`.
8. Confirm the inbound message appears in CRM.
9. Confirm AI replies.
10. Add a fresh lead whose 24h window is closed and confirm the approved template is sent.
11. Reply to that template and confirm normal AI text replies continue.
12. Test delivered/read/failed status events.

## 7. Rules you cannot bypass

- A normal free-text business message cannot be used to initiate/re-open a conversation outside Meta's 24h customer-service window.
- An approved template is required for that business-initiated case.
- The customer's latest inbound message opens/refreshes the 24h window; your own outbound message does not.
- Meta is the source of truth for whether an outbound message is accepted.
