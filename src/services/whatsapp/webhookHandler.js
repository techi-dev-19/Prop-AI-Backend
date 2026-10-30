// const Lead = require("../../models/Lead");
// const Conversation = require("../../models/Conversation");
// const Message = require("../../models/Message");
// const User = require("../../models/User");
// const Notification = require("../../models/Notification");
// const logger = require("../../utils/logger");
// const { emitToUser } = require("../../sockets");
// const conversationEngine = require("../ai/conversationEngine");
// const env = require("../../config/env");

// /**
//  * Real Meta WhatsApp Cloud API "messages" webhook body:
//  * {
//  *   "object": "whatsapp_business_account",
//  *   "entry": [{
//  *     "id": "<WABA_ID>",
//  *     "changes": [{
//  *       "field": "messages",
//  *       "value": {
//  *         "messaging_product": "whatsapp",
//  *         "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
//  *         "contacts": [{ "profile": { "name": "Ramesh" }, "wa_id": "919876543210" }],
//  *         "messages": [{
//  *           "from": "919876543210",
//  *           "id": "wamid.HBg...",
//  *           "timestamp": "1731500000",
//  *           "type": "text",
//  *           "text": { "body": "Hello" }
//  *         }],
//  *         // Delivery/read receipts arrive as `statuses`, not `messages` —
//  *         // same webhook field, different shape; must be ignored here.
//  *         "statuses": [{ "id": "wamid...", "status": "delivered", ... }]
//  *       }
//  *     }]
//  *   }]
//  * }
//  */

// /**
//  * Canonical phone format we WRITE to the DB going forward: bare digits with
//  * country code, no "+", no spaces/dashes. Meta's `from` / `wa_id` fields are
//  * already in this exact shape, so this is mostly a safety net.
//  */
// function normalizePhone(rawPhone) {
//   if (!rawPhone) return null;
//   const digits = String(rawPhone).replace(/[^\d]/g, "");
//   return digits || null;
// }

// /**
//  * Leads can have their phone saved in different formats depending on how
//  * they came in ("+919876543210", "919876543210", or even just "9876543210"
//  * without a country code) — but the incoming webhook always gives us bare
//  * digits with country code (e.g. "919876543210"). Try the exact digit and
//  * "+digit" forms first, then fall back to a last-10-digit suffix match so a
//  * lead saved without a country code still resolves correctly.
//  */
// async function findLeadByPhone(digits) {
//   if (!digits) return null;

//   let lead = await Lead.findOne({ phone: { $in: [digits, `+${digits}`] } });
//   if (lead) return lead;

//   const last10 = digits.slice(-10);
//   if (last10.length === 10) {
//     lead = await Lead.findOne({ phone: new RegExp(`${last10}$`) });
//   }
//   return lead;
// }

// /**
//  * Resolves which broker/user a brand-new inbound lead (one who messaged us
//  * first, before ever being added/imported) should belong to. Since this
//  * deployment has exactly ONE connected WhatsApp number (META_WHATSAPP_PHONE_
//  * NUMBER_ID is global, not per-org), there's no per-message signal telling
//  * us which broker's number this is — so we rely on DEFAULT_LEAD_OWNER_ID,
//  * falling back to the first admin/broker account if that's not configured.
//  *
//  * Cached in-process for a few minutes so every inbound message from an
//  * unknown number doesn't re-hit the Users collection.
//  */
// let cachedOwner = null;
// let cachedOwnerAt = 0;
// const OWNER_CACHE_MS = 5 * 60 * 1000;

// async function resolveDefaultOwner() {
//   if (cachedOwner && Date.now() - cachedOwnerAt < OWNER_CACHE_MS)
//     return cachedOwner;

//   let owner = null;
//   if (env.leads.defaultOwnerId) {
//     owner = await User.findById(env.leads.defaultOwnerId);
//     if (!owner) {
//       logger.warn(
//         `[whatsapp] DEFAULT_LEAD_OWNER_ID=${env.leads.defaultOwnerId} does not match any User — falling back`,
//       );
//     }
//   }

//   if (!owner) {
//     owner = await User.findOne({
//       role: { $in: ["broker", "builder", "admin"] },
//       isActive: true,
//     }).sort({ createdAt: 1 });
//   }

//   if (owner) {
//     cachedOwner = owner;
//     cachedOwnerAt = Date.now();
//   }
//   return owner;
// }

// /**
//  * Creates a Conversation for a lead, safely handling the case where a
//  * concurrent webhook delivery (retry, or two near-simultaneous messages)
//  * already created one in a race — `leadId` is unique on Conversation, so
//  * the loser of the race re-fetches instead of throwing.
//  */
// async function findOrCreateConversation(lead) {
//   let conversation = await Conversation.findOne({ leadId: lead._id });
//   if (conversation) return conversation;

//   try {
//     conversation = await Conversation.create({
//       leadId: lead._id,
//       ownerId: lead.ownerId,
//     });
//   } catch (err) {
//     if (err.code === 11000) {
//       conversation = await Conversation.findOne({ leadId: lead._id });
//     } else {
//       throw err;
//     }
//   }
//   return conversation;
// }

// /**
//  * Someone messaged the connected WhatsApp number who isn't in the CRM yet
//  * (no lead has this phone). Auto-creates a Lead + Conversation for them so
//  * the AI engine can pick the message up exactly like it would for any
//  * existing lead — this is what makes "new number messages us -> AI responds
//  * too" work, not just "we message a number first".
//  */
// async function createLeadForUnknownSender(phone, contactName) {
//   const owner = await resolveDefaultOwner();
//   if (!owner) {
//     logger.warn(
//       `[whatsapp] Inbound message from unrecognized number ${phone} — no default lead owner configured (set DEFAULT_LEAD_OWNER_ID or create a broker/admin user), ignoring`,
//     );
//     return null;
//   }

//   // Phone can't collide with an existing lead here (findLeadByPhone already
//   // returned nothing), but two webhook retries racing each other could both
//   // reach this point — the unique (ownerId, phone) index is the real guard;
//   // fall back to re-fetching if we lose that race.
//   let lead;
//   try {
//     lead = await Lead.create({
//       ownerId: owner._id,
//       name: contactName || `WhatsApp ${phone}`,
//       phone,
//       source: "whatsapp_inbound",
//     });
//   } catch (err) {
//     if (err.code === 11000) {
//       lead = await Lead.findOne({ ownerId: owner._id, phone });
//     } else {
//       throw err;
//     }
//   }
//   if (!lead) return null;

//   const conversation = await findOrCreateConversation(lead);

//   logger.info(
//     `[whatsapp] Auto-created new lead ${lead._id} for unrecognized inbound number ${phone}`,
//   );

//   await Notification.create({
//     userId: owner._id,
//     type: "new_lead",
//     title: `New WhatsApp message from ${phone}`,
//     body: "This number messaged you first and was added as a new lead automatically.",
//     link: `/leads/${lead._id}`,
//   });
//   emitToUser(owner._id, "notification:new", { leadId: lead._id });
//   emitToUser(owner._id, "lead:new", { lead });

//   return { lead, conversation };
// }

// /**
//  * Extracts a display-safe text body from a Meta inbound message object,
//  * across the message types worth supporting today. Anything without usable
//  * text (pure image/audio/video/document/sticker with no caption, or a type
//  * we don't handle yet) gets a placeholder so the broker still sees "customer
//  * sent something" instead of the conversation looking dead.
//  */
// function extractText(msg) {
//   switch (msg.type) {
//     case "text":
//       return msg.text?.body?.trim() || "";
//     case "button":
//       // Quick-reply button on a template we sent earlier.
//       return msg.button?.text?.trim() || "";
//     case "interactive":
//       return (
//         msg.interactive?.button_reply?.title?.trim() ||
//         msg.interactive?.list_reply?.title?.trim() ||
//         ""
//       );
//     default:
//       return "";
//   }
// }

// function placeholderTextFor(msg) {
//   return `[${msg.type || "media"} message — not yet supported for preview]`;
// }

// /**
//  * Handles one inbound message object from a Meta webhook delivery.
//  * Always resolves/returns quickly and never throws — Meta retries on any
//  * non-200 response, and a thrown error here would otherwise turn one bad
//  * payload into repeated retried duplicate deliveries.
//  */
// async function handleInboundMessage(waMessage, contact) {
//   const rawText = extractText(waMessage);
//   const text = rawText || placeholderTextFor(waMessage);

//   const phone = normalizePhone(waMessage.from);
//   if (!phone) {
//     logger.warn(
//       "[whatsapp] Webhook message had no resolvable sender phone number, ignoring",
//       { messageId: waMessage.id },
//     );
//     return;
//   }

//   let lead = await findLeadByPhone(phone);
//   let conversation;

//   if (!lead) {
//     // Brand-new number we've never seen before — auto-create the lead
//     // (and its conversation) so the AI can respond to them too, instead
//     // of only ever replying to numbers that were imported/added first.
//     const created = await createLeadForUnknownSender(
//       phone,
//       contact?.profile?.name,
//     );
//     if (!created) return; // no default owner configured — see createLeadForUnknownSender for how to fix
//     ({ lead, conversation } = created);
//   } else {
//     conversation = await findOrCreateConversation(lead);
//   }

//   const whatsappMessageId = waMessage.id;
//   if (whatsappMessageId) {
//     const alreadyExists = await Message.findOne({ whatsappMessageId }).lean();
//     if (alreadyExists) return; // dedup — webhook retry protection
//   }

//   const timestampSec = Number(waMessage.timestamp);
//   const timestamp = Number.isFinite(timestampSec)
//     ? new Date(timestampSec * 1000)
//     : new Date();

//   const savedMessage = await Message.create({
//     conversationId: conversation._id,
//     leadId: lead._id,
//     direction: "inbound",
//     sender: "customer",
//     text,
//     whatsappMessageId: whatsappMessageId || null,
//     timestamp,
//   });

//   conversation.lastMessageAt = savedMessage.timestamp;
//   conversation.lastInboundAt = savedMessage.timestamp;
//   conversation.unreadCount += 1;
//   // Once the lead has messaged us for real, the opening template's job is
//   // done — every reply from here on is free-text within the 24h window.
//   conversation.templateSent = true;
//   await conversation.save();

//   emitToUser(lead.ownerId, "conversation:newMessage", {
//     conversationId: conversation._id,
//     leadId: lead._id,
//     message: savedMessage,
//   });

//   // Fire-and-forget best-effort blue ticks; never block the AI turn on this.
//   require("./metaWhatsappClient")
//     .markAsRead(whatsappMessageId)
//     .catch(() => {});

//   require("./metaWhatsappClient")
//     .sendTypingIndicator(whatsappMessageId)
//     .catch(() => {});

//   // Hand off to the AI engine. Awaited so replies for a given lead stay in
//   // order, but wrapped in its own try/catch — an AI failure must never
//   // surface back as a webhook failure (which would trigger Meta retries).
//   try {
//     await conversationEngine.handleInbound({
//       conversation,
//       lead,
//       message: savedMessage,
//     });
//   } catch (aiErr) {
//     logger.error(`[ai] Conversation engine failed for lead ${lead._id}`, {
//       error: aiErr.message,
//     });
//   }
// }

// /**
//  * Entry point called by the webhook controller for every POST delivery.
//  * A single delivery can contain multiple entries/changes/messages batched
//  * together, so everything here is looped, and each message is processed
//  * one at a time (kept sequential — simpler ordering guarantees, and volume
//  * per delivery is tiny in practice).
//  */
// async function handleWebhook(payload) {
//   try {
//     if (!payload || payload.object !== "whatsapp_business_account") return;

//     const entries = Array.isArray(payload.entry) ? payload.entry : [];
//     for (const entry of entries) {
//       const changes = Array.isArray(entry.changes) ? entry.changes : [];
//       for (const change of changes) {
//         if (change.field !== "messages") continue; // ignore non-message webhook fields
//         const value = change.value || {};

//         // Status callbacks (sent/delivered/read/failed for OUR outbound
//         // messages) land here too, under `statuses` instead of `messages` —
//         // nothing to do with them yet, just don't treat them as inbound text.
//         if (Array.isArray(value.statuses) && value.statuses.length) {
//           for (const s of value.statuses) {
//             const mappedStatus = [
//               "sent",
//               "delivered",
//               "read",
//               "failed",
//             ].includes(s.status)
//               ? s.status
//               : null;
//             if (mappedStatus && s.id) {
//               const firstError = Array.isArray(s.errors) ? s.errors[0] : null;
//               await Message.updateOne(
//                 { whatsappMessageId: s.id },
//                 {
//                   $set: {
//                     status: mappedStatus,
//                     errorCode: firstError?.code
//                       ? String(firstError.code)
//                       : null,
//                     errorMessage:
//                       firstError?.title || firstError?.message || null,
//                   },
//                 },
//               );
//             }
//             if (s.status === "failed") {
//               logger.warn("[whatsapp] Outbound message delivery failed", {
//                 messageId: s.id,
//                 errors: s.errors,
//               });
//             }
//           }
//         }

//         const messages = Array.isArray(value.messages) ? value.messages : [];
//         if (!messages.length) continue;

//         const contactsByWaId = new Map(
//           (value.contacts || []).map((c) => [c.wa_id, c]),
//         );

//         for (const waMessage of messages) {
//           logger.info(
//             `[whatsapp] Webhook message received: type=${waMessage.type} from=${waMessage.from} id=${waMessage.id}`,
//           );
//           await handleInboundMessage(
//             waMessage,
//             contactsByWaId.get(waMessage.from),
//           );
//         }
//       }
//     }
//   } catch (err) {
//     logger.error("[whatsapp] Failed to process webhook payload", {
//       error: err.message,
//     });
//   }
// }

// module.exports = { handleWebhook, normalizePhone, findLeadByPhone };

const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const User = require("../../models/User");
const Notification = require("../../models/Notification");
const logger = require("../../utils/logger");
const { emitToUser } = require("../../sockets");
const conversationEngine = require("../ai/conversationEngine");
const env = require("../../config/env");
const { applyDeliveryFailure } = require("../queue/deliveryFailures");

/**
 * Real Meta WhatsApp Cloud API "messages" webhook body:
 * {
 *   "object": "whatsapp_business_account",
 *   "entry": [{
 *     "id": "<WABA_ID>",
 *     "changes": [{
 *       "field": "messages",
 *       "value": {
 *         "messaging_product": "whatsapp",
 *         "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
 *         "contacts": [{ "profile": { "name": "Ramesh" }, "wa_id": "919876543210" }],
 *         "messages": [{
 *           "from": "919876543210",
 *           "id": "wamid.HBg...",
 *           "timestamp": "1731500000",
 *           "type": "text",
 *           "text": { "body": "Hello" }
 *         }],
 *         // Delivery/read receipts arrive as `statuses`, not `messages` —
 *         // same webhook field, different shape; must be ignored here.
 *         "statuses": [{ "id": "wamid...", "status": "delivered", ... }]
 *       }
 *     }]
 *   }]
 * }
 */

/**
 * Canonical phone format we WRITE to the DB going forward: bare digits with
 * country code, no "+", no spaces/dashes. Meta's `from` / `wa_id` fields are
 * already in this exact shape, so this is mostly a safety net.
 */
function normalizePhone(rawPhone) {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/[^\d]/g, "");
  return digits || null;
}

/**
 * Leads can have their phone saved in different formats depending on how
 * they came in ("+919876543210", "919876543210", or even just "9876543210"
 * without a country code) — but the incoming webhook always gives us bare
 * digits with country code (e.g. "919876543210"). Try the exact digit and
 * "+digit" forms first, then fall back to a last-10-digit suffix match so a
 * lead saved without a country code still resolves correctly.
 */
async function findLeadByPhone(digits) {
  if (!digits) return null;

  let lead = await Lead.findOne({ phone: { $in: [digits, `+${digits}`] } });
  if (lead) return lead;

  const last10 = digits.slice(-10);
  if (last10.length === 10) {
    lead = await Lead.findOne({ phone: new RegExp(`${last10}$`) });
  }
  return lead;
}

/**
 * Resolves which broker/user a brand-new inbound lead (one who messaged us
 * first, before ever being added/imported) should belong to. Since this
 * deployment has exactly ONE connected WhatsApp number (META_WHATSAPP_PHONE_
 * NUMBER_ID is global, not per-org), there's no per-message signal telling
 * us which broker's number this is — so we rely on DEFAULT_LEAD_OWNER_ID,
 * falling back to the first admin/broker account if that's not configured.
 *
 * Cached in-process for a few minutes so every inbound message from an
 * unknown number doesn't re-hit the Users collection.
 */
let cachedOwner = null;
let cachedOwnerAt = 0;
const OWNER_CACHE_MS = 5 * 60 * 1000;

async function resolveDefaultOwner() {
  if (cachedOwner && Date.now() - cachedOwnerAt < OWNER_CACHE_MS)
    return cachedOwner;

  let owner = null;
  if (env.leads.defaultOwnerId) {
    owner = await User.findById(env.leads.defaultOwnerId);
    if (!owner) {
      logger.warn(
        `[whatsapp] DEFAULT_LEAD_OWNER_ID=${env.leads.defaultOwnerId} does not match any User — falling back`,
      );
    }
  }

  if (!owner) {
    owner = await User.findOne({
      role: { $in: ["broker", "builder", "admin"] },
      isActive: true,
    }).sort({ createdAt: 1 });
  }

  if (owner) {
    cachedOwner = owner;
    cachedOwnerAt = Date.now();
  }
  return owner;
}

/**
 * Creates a Conversation for a lead, safely handling the case where a
 * concurrent webhook delivery (retry, or two near-simultaneous messages)
 * already created one in a race — `leadId` is unique on Conversation, so
 * the loser of the race re-fetches instead of throwing.
 */
async function findOrCreateConversation(lead) {
  let conversation = await Conversation.findOne({ leadId: lead._id });
  if (conversation) return conversation;

  try {
    conversation = await Conversation.create({
      leadId: lead._id,
      ownerId: lead.ownerId,
    });
  } catch (err) {
    if (err.code === 11000) {
      conversation = await Conversation.findOne({ leadId: lead._id });
    } else {
      throw err;
    }
  }
  return conversation;
}

/**
 * Someone messaged the connected WhatsApp number who isn't in the CRM yet
 * (no lead has this phone). Auto-creates a Lead + Conversation for them so
 * the AI engine can pick the message up exactly like it would for any
 * existing lead — this is what makes "new number messages us -> AI responds
 * too" work, not just "we message a number first".
 */
async function createLeadForUnknownSender(phone, contactName) {
  const owner = await resolveDefaultOwner();
  if (!owner) {
    logger.warn(
      `[whatsapp] Inbound message from unrecognized number ${phone} — no default lead owner configured (set DEFAULT_LEAD_OWNER_ID or create a broker/admin user), ignoring`,
    );
    return null;
  }

  // Phone can't collide with an existing lead here (findLeadByPhone already
  // returned nothing), but two webhook retries racing each other could both
  // reach this point — the unique (ownerId, phone) index is the real guard;
  // fall back to re-fetching if we lose that race.
  let lead;
  try {
    lead = await Lead.create({
      ownerId: owner._id,
      name: contactName || `WhatsApp ${phone}`,
      phone,
      source: "whatsapp_inbound",
    });
  } catch (err) {
    if (err.code === 11000) {
      lead = await Lead.findOne({ ownerId: owner._id, phone });
    } else {
      throw err;
    }
  }
  if (!lead) return null;

  const conversation = await findOrCreateConversation(lead);

  logger.info(
    `[whatsapp] Auto-created new lead ${lead._id} for unrecognized inbound number ${phone}`,
  );

  await Notification.create({
    userId: owner._id,
    type: "new_lead",
    title: `New WhatsApp message from ${phone}`,
    body: "This number messaged you first and was added as a new lead automatically.",
    link: `/leads/${lead._id}`,
  });
  emitToUser(owner._id, "notification:new", { leadId: lead._id });
  emitToUser(owner._id, "lead:new", { lead });

  return { lead, conversation };
}

/**
 * Extracts a display-safe text body from a Meta inbound message object,
 * across the message types worth supporting today. Anything without usable
 * text (pure image/audio/video/document/sticker with no caption, or a type
 * we don't handle yet) gets a placeholder so the broker still sees "customer
 * sent something" instead of the conversation looking dead.
 */
function extractText(msg) {
  switch (msg.type) {
    case "text":
      return msg.text?.body?.trim() || "";
    case "button":
      // Quick-reply button on a template we sent earlier.
      return msg.button?.text?.trim() || "";
    case "interactive":
      return (
        msg.interactive?.button_reply?.title?.trim() ||
        msg.interactive?.list_reply?.title?.trim() ||
        ""
      );
    default:
      return "";
  }
}

function placeholderTextFor(msg) {
  return `[${msg.type || "media"} message — not yet supported for preview]`;
}

/**
 * Handles one inbound message object from a Meta webhook delivery.
 * Always resolves/returns quickly and never throws — Meta retries on any
 * non-200 response, and a thrown error here would otherwise turn one bad
 * payload into repeated retried duplicate deliveries.
 */
async function handleInboundMessage(waMessage, contact) {
  const rawText = extractText(waMessage);
  const text = rawText || placeholderTextFor(waMessage);

  const phone = normalizePhone(waMessage.from);
  if (!phone) {
    logger.warn(
      "[whatsapp] Webhook message had no resolvable sender phone number, ignoring",
      { messageId: waMessage.id },
    );
    return;
  }

  let lead = await findLeadByPhone(phone);
  let conversation;

  if (!lead) {
    // Brand-new number we've never seen before — auto-create the lead
    // (and its conversation) so the AI can respond to them too, instead
    // of only ever replying to numbers that were imported/added first.
    const created = await createLeadForUnknownSender(
      phone,
      contact?.profile?.name,
    );
    if (!created) return; // no default owner configured — see createLeadForUnknownSender for how to fix
    ({ lead, conversation } = created);
  } else {
    conversation = await findOrCreateConversation(lead);
  }

  const whatsappMessageId = waMessage.id;
  if (whatsappMessageId) {
    const alreadyExists = await Message.findOne({ whatsappMessageId }).lean();
    if (alreadyExists) return; // dedup — webhook retry protection
  }

  const timestampSec = Number(waMessage.timestamp);
  const timestamp = Number.isFinite(timestampSec)
    ? new Date(timestampSec * 1000)
    : new Date();

  const savedMessage = await Message.create({
    conversationId: conversation._id,
    leadId: lead._id,
    direction: "inbound",
    sender: "customer",
    text,
    whatsappMessageId: whatsappMessageId || null,
    timestamp,
  });

  conversation.lastMessageAt = savedMessage.timestamp;
  conversation.lastInboundAt = savedMessage.timestamp;
  conversation.unreadCount += 1;
  // Once the lead has messaged us for real, the opening template's job is
  // done — every reply from here on is free-text within the 24h window.
  conversation.templateSent = true;
  await conversation.save();

  emitToUser(lead.ownerId, "conversation:newMessage", {
    conversationId: conversation._id,
    leadId: lead._id,
    message: savedMessage,
  });

  // Fire-and-forget best-effort blue ticks; never block the AI turn on this.
  require("./metaWhatsappClient")
    .markAsRead(whatsappMessageId)
    .catch(() => {});

  require("./metaWhatsappClient")
    .sendTypingIndicator(whatsappMessageId)
    .catch(() => {});

  // Hand off to the AI engine. Awaited so replies for a given lead stay in
  // order, but wrapped in its own try/catch — an AI failure must never
  // surface back as a webhook failure (which would trigger Meta retries).
  try {
    await conversationEngine.handleInbound({
      conversation,
      lead,
      message: savedMessage,
    });
  } catch (aiErr) {
    logger.error(`[ai] Conversation engine failed for lead ${lead._id}`, {
      error: aiErr.message,
    });
  }
}

/**
 * Entry point called by the webhook controller for every POST delivery.
 * A single delivery can contain multiple entries/changes/messages batched
 * together, so everything here is looped, and each message is processed
 * one at a time (kept sequential — simpler ordering guarantees, and volume
 * per delivery is tiny in practice).
 */
async function handleWebhook(payload) {
  try {
    if (!payload || payload.object !== "whatsapp_business_account") return;

    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        if (change.field !== "messages") continue; // ignore non-message webhook fields
        const value = change.value || {};

        // Status callbacks (sent/delivered/read/failed for OUR outbound
        // messages) land here too, under `statuses` instead of `messages` —
        // nothing to do with them yet, just don't treat them as inbound text.
        if (Array.isArray(value.statuses) && value.statuses.length) {
          for (const s of value.statuses) {
            const mappedStatus = [
              "sent",
              "delivered",
              "read",
              "failed",
            ].includes(s.status)
              ? s.status
              : null;
            if (mappedStatus && s.id) {
              const firstError = Array.isArray(s.errors) ? s.errors[0] : null;
              const updatedMessage = await Message.findOneAndUpdate(
                { whatsappMessageId: s.id },
                {
                  $set: {
                    status: mappedStatus,
                    errorCode: firstError?.code
                      ? String(firstError.code)
                      : null,
                    errorMessage:
                      firstError?.title || firstError?.message || null,
                  },
                },
                { new: true },
              )
                .select("outboundJobId")
                .lean();

              // Bulk campaign ka message tha? To Outreach job ko bhi "failed"
              // mark karo, taaki Failed filter / campaign card mein dikhe.
              if (mappedStatus === "failed" && updatedMessage?.outboundJobId) {
                try {
                  await applyDeliveryFailure({
                    jobId: updatedMessage.outboundJobId,
                    error: firstError,
                  });
                } catch (jobErr) {
                  logger.error(
                    "[whatsapp] Could not mark outreach job as delivery-failed",
                    { error: jobErr.message, messageId: s.id },
                  );
                }
              }
            }
            if (s.status === "failed") {
              logger.warn("[whatsapp] Outbound message delivery failed", {
                messageId: s.id,
                errors: s.errors,
              });
            }
          }
        }

        const messages = Array.isArray(value.messages) ? value.messages : [];
        if (!messages.length) continue;

        const contactsByWaId = new Map(
          (value.contacts || []).map((c) => [c.wa_id, c]),
        );

        for (const waMessage of messages) {
          logger.info(
            `[whatsapp] Webhook message received: type=${waMessage.type} from=${waMessage.from} id=${waMessage.id}`,
          );
          await handleInboundMessage(
            waMessage,
            contactsByWaId.get(waMessage.from),
          );
        }
      }
    }
  } catch (err) {
    logger.error("[whatsapp] Failed to process webhook payload", {
      error: err.message,
    });
  }
}

module.exports = { handleWebhook, normalizePhone, findLeadByPhone };
