const crypto = require("crypto");
const { analyzeLeadAsync } = require("../services/ai/leadAnalyzer");
const EmailMessage = require("../models/EmailMessage");
const Notification = require("../models/Notification");
const logger = require("../utils/logger");
const env = require("../config/env");
const { emitToUser } = require("../sockets");

function constantTimeMatch(expected, supplied) {
  const a = Buffer.from(String(expected || ""));
  const b = Buffer.from(String(supplied || ""));
  return Boolean(a.length && a.length === b.length && crypto.timingSafeEqual(a, b));
}

// Brevo webhooks can send a custom header. Configure X-PropAI-Webhook-Secret
// on both the transactional and inbound-parsing webhook definitions.
function isAuthorized(req) {
  const expected = env.brevo?.webhookSecret;
  if (!expected) return false;
  const supplied = req.get("x-propai-webhook-secret")
    || req.get("x-brevo-webhook-secret")
    || (String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]);
  return constantTimeMatch(expected, supplied);
}

function emailAddress(value) {
  if (value && typeof value === "object") {
    return String(value.Address || value.address || value.email || "").trim().toLowerCase();
  }
  const raw = String(value || "").trim();
  const bracket = raw.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const match = bracket?.[1] || raw.match(/[^\s<>;,]+@[^\s<>;,]+\.[^\s<>;,]+/)?.[0] || raw;
  return String(match || "").replace(/[>,]+$/, "").trim().toLowerCase();
}

function getHeader(headers, wanted) {
  if (!headers) return "";
  if (Array.isArray(headers)) {
    const hit = headers.find((value) => String(value?.name || value?.key || "").toLowerCase() === wanted.toLowerCase());
    return String(hit?.value || "");
  }
  const key = Object.keys(headers).find((name) => name.toLowerCase() === wanted.toLowerCase());
  const val = key ? headers[key] : "";
  return Array.isArray(val) ? val.join(" ") : String(val || "");
}

function collectRecipients(item) {
  const toValues = Array.isArray(item.To) ? item.To : item.To ? [item.To] : [];
  const rcptValues = Array.isArray(item.Recipients) ? item.Recipients : item.Recipients ? [item.Recipients] : [];
  return [...new Set([...toValues, ...rcptValues].map(emailAddress).filter(Boolean))];
}

function pickTagStrings(data) {
  const source = data.tags ?? data.tag ?? data.Tags ?? [];
  if (Array.isArray(source)) return source.map((value) => typeof value === "object" ? `${value.name || ""}_${value.value || ""}` : String(value));
  return String(source || "").split(/[\s,;]+/).filter(Boolean);
}

function taggedObjectId(tags, key) {
  const all = tags.join(" ");
  const pattern = new RegExp(`(?:^|[^a-z0-9])${key}[_:-]([a-f0-9]{24})(?:$|[^a-z0-9])`, "i");
  return all.match(pattern)?.[1] || null;
}

async function findOutboundByProviderId(providerId) {
  if (!providerId) return null;
  const clean = String(providerId).trim();
  const unbracketed = clean.replace(/^<|>$/g, "");
  const bracketed = unbracketed ? `<${unbracketed}>` : clean;
  return EmailMessage.findOne({
    direction: "outbound",
    $or: [
      { providerMessageId: clean },
      { providerMessageId: unbracketed },
      { providerMessageId: bracketed },
      { rfcMessageId: clean },
      { rfcMessageId: unbracketed },
      { rfcMessageId: bracketed },
    ],
  }).select("_id").lean();
}

async function processInboundItem(item) {
  const messageId = String(item.MessageId || item.messageId || item.message_id || "").trim();
  const inboundEventId = messageId ? `brevo-inbound:${messageId}` : null;
  if (inboundEventId && await EmailMessage.exists({ providerEventId: inboundEventId })) return;

  const recipients = collectRecipients(item);
  let matched = null;
  for (const recipient of recipients) {
    const trackingMatch = recipient.match(/reply\+([a-f0-9]{32})@/i);
    if (trackingMatch) {
      matched = await EmailMessage.findOne({ trackingId: trackingMatch[1].toLowerCase(), direction: "outbound" }).lean();
      if (matched) break;
    }
  }

  const originalMessageId = String(item.InReplyTo || item.inReplyTo || getHeader(item.Headers || item.headers, "In-Reply-To") || "").trim();
  if (!matched && originalMessageId) {
    matched = await EmailMessage.findOne({
      direction: "outbound",
      $or: [
        { rfcMessageId: originalMessageId },
        { providerMessageId: originalMessageId },
        { rfcMessageId: originalMessageId.replace(/^<|>$/g, "") },
        { providerMessageId: originalMessageId.replace(/^<|>$/g, "") },
      ],
    }).sort({ createdAt: -1 }).lean();
  }

  if (!matched) {
    logger.warn("[brevo-webhook] Inbound email could not be correlated to a PropAI email", {
      messageId,
      recipients,
      hasInReplyTo: Boolean(originalMessageId),
    });
    return;
  }

  const rootId = matched.threadId || matched._id;
  const root = await EmailMessage.findOne({ _id: rootId });
  if (!root) return;

  const from = emailAddress(item.From || item.from);
  const inbound = new EmailMessage({
    ownerId: root.ownerId,
    leadId: root.leadId,
    campaignId: root.campaignId || undefined,
    direction: "inbound",
    kind: "received",
    threadId: rootId,
    parentMessageId: matched._id,
    providerMessageId: messageId || undefined,
    providerEventId: inboundEventId || undefined,
    rfcMessageId: messageId || undefined,
    from,
    to: recipients.join(", "),
    subject: String(item.Subject || item.subject || ""),
    text: String(item.ExtractedMarkdownMessage || item.RawTextBody || item.TextBody || item.text || ""),
    html: String(item.RawHtmlBody || item.HtmlBody || item.html || ""),
    status: "received",
    receivedAt: item.SentAtDate ? new Date(item.SentAtDate) : new Date(),
  });

  try {
    await inbound.save();
  } catch (err) {
    if (err.code === 11000) return; // Webhook delivery can be retried.
    throw err;
  }

  await EmailMessage.updateOne(
    { _id: rootId },
    { $set: { replyStatus: "replied", lastReplyAt: inbound.receivedAt }, $inc: { replyCount: 1 } },
  );

  try {
    await Notification.create({
      userId: root.ownerId,
      type: "email_reply_received",
      title: `Email reply from ${from || "a lead"}`,
      body: String(inbound.subject || inbound.text || "New customer email reply").slice(0, 240),
      link: "/email/conversations",
    });
  } catch (err) {
    logger.warn("[brevo-webhook] Could not create reply notification", { error: err.message });
  }
  // Score the lead from the email reply too (lead rules: > 30 lead, > 60 hot).
  if (root.leadId) {
    analyzeLeadAsync({ leadId: root.leadId }).catch((err) =>
      logger.warn("[brevo-webhook] Lead scoring after email reply failed", { error: err.message }));
  }
  emitToUser(root.ownerId, "email:reply", {
    threadId: String(rootId),
    messageId: String(inbound._id),
    leadId: String(root.leadId || ""),
  });
}

function normalizeEventName(value) {
  return String(value || "").toLowerCase().replace(/[\s_-]+/g, "");
}

function parseEventDate(value) {
  if (value === undefined || value === null || value === "") return new Date();
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const numeric = Number(value);
    return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

const STATUS_MAP = {
  sent: "sent",
  request: "sent",
  delivered: "delivered",
  deferred: "delivery_delayed",
  softbounce: "delivery_delayed",
  hardbounce: "bounced",
  invalid: "bounced",
  blocked: "suppressed",
  spam: "complained",
  unsubscribed: "suppressed",
  error: "failed",
};

async function processTransactionalEvent(event) {
  const providerId = event["message-id"] || event.messageId || event.message_id || event.email_id;
  const eventId = String(event.uuid || event.eventId || event.event_id || "");
  const eventName = normalizeEventName(event.event || event.type);
  const tags = pickTagStrings(event);
  let tracked = await findOutboundByProviderId(providerId);

  if (!tracked) {
    const messageObjectId = taggedObjectId(tags, "propai_message_id");
    const jobObjectId = taggedObjectId(tags, "propai_job_id");
    if (messageObjectId) tracked = await EmailMessage.findById(messageObjectId).select("_id").lean();
    else if (jobObjectId) tracked = await EmailMessage.findOne({ outboundJobId: jobObjectId, direction: "outbound" }).select("_id").lean();
  }
  if (!tracked) {
    logger.info("[brevo-webhook] Event received before tracked message could be matched", { eventName, providerId });
    return;
  }
  if (eventId && await EmailMessage.exists({ _id: tracked._id, eventIds: eventId })) return;

  const update = {};
  const status = STATUS_MAP[eventName];
  if (status) update.status = status;
  const eventTime = parseEventDate(event.ts_event || event.date || event.timestamp);
  if (["opened", "firstopening", "uniqueopened", "proxyopen", "uniqueproxyopen"].includes(eventName)) update.openedAt = eventTime;
  if (eventName === "click" || eventName === "clicked") update.clickedAt = eventTime;
  if (["hardbounce", "softbounce", "invalid", "blocked", "spam", "error", "unsubscribed"].includes(eventName)) {
    update.errorMessage = String(event.reason || event.reason_message || event.response || eventName).slice(0, 500);
  }
  if (providerId) update.providerMessageId = String(providerId);

  const filter = { _id: tracked._id, direction: "outbound" };
  if (status) {
    const allowedPrevious = {
      sent: ["queued", "sending", "sent"],
      delivery_delayed: ["queued", "sending", "sent", "delivery_delayed"],
      delivered: ["queued", "sending", "sent", "delivery_delayed", "delivered"],
      bounced: ["queued", "sending", "sent", "delivery_delayed", "bounced"],
      complained: ["queued", "sending", "sent", "delivery_delayed", "delivered", "complained"],
      failed: ["queued", "sending", "sent", "delivery_delayed", "failed"],
      suppressed: ["queued", "sending", "sent", "delivery_delayed", "suppressed"],
    };
    if (allowedPrevious[status]) filter.status = { $in: allowedPrevious[status] };
  }
  if (!Object.keys(update).length && !eventId) return;
  await EmailMessage.updateOne(filter, {
    ...(Object.keys(update).length ? { $set: update } : {}),
    ...(eventId ? { $addToSet: { eventIds: eventId } } : {}),
  });
}

async function handler(req, res) {
  if (!env.brevo?.webhookSecret) {
    logger.error("[brevo-webhook] BREVO_WEBHOOK_SECRET is missing");
    return res.status(503).json({ success: false, message: "Brevo webhook is not configured" });
  }
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: "Invalid webhook authentication" });

  try {
    const payload = req.body || {};
    if (Array.isArray(payload.items)) {
      for (const item of payload.items) await processInboundItem(item);
      return res.status(200).json({ success: true, received: true, processed: payload.items.length });
    }
    if (Array.isArray(payload)) {
      for (const event of payload) await processTransactionalEvent(event);
      return res.status(200).json({ success: true, received: true, processed: payload.length });
    }
    await processTransactionalEvent(payload);
    return res.status(200).json({ success: true, received: true });
  } catch (err) {
    logger.error("[brevo-webhook] Event processing failed", { event: req.body?.event, error: err.message });
    return res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
}

module.exports = { handler };
