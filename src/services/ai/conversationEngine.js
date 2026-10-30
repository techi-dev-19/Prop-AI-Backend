/**
 * WhatsApp conversation engine — PropAI Sales Agent.
 *
 * Flow for every customer message:
 *   1. Per-lead lock + short debounce (2 quick messages → ONE reply, no
 *      parallel Gemini calls for the same chat).
 *   2. First contact → editable welcome message + language buttons
 *      (Hindi / Hinglish / English). No AI call needed.
 *   3. Otherwise → salesAgent.runSalesTurn() (Gemini with model fallback;
 *      scripted reply if every model is down — the customer is never left
 *      without an answer).
 *   4. Send reply (with quick-reply buttons / list), then any sales images.
 *   5. Save qualification (business type, lead volume, challenge…), create a
 *      demo request when date+time are known, alert the team, score the lead.
 */
const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const Meeting = require("../../models/Meeting");
const Notification = require("../../models/Notification");
const OutboundJob = require("../../models/OutboundJob");

const settingsService = require("../settings/settingsService");
const metaWhatsappClient = require("../whatsapp/metaWhatsappClient");
const { recordOutboundMessage } = require("../whatsapp/messageStore");
const salesAgent = require("./salesAgent");
const { analyzeConversationAsync } = require("./leadAnalyzer");
const {
  createCalendarEvent,
  updateCalendarEvent,
} = require("../calendar/googleCalendarService");
const { enqueueLeads } = require("../queue/outboundQueue");
const env = require("../../config/env");
const { emitToUser } = require("../../sockets");
const logger = require("../../utils/logger");

const HISTORY_LIMIT = 16; // recent messages sent to the model as memory
const DEBOUNCE_MS = Number(process.env.AI_REPLY_DEBOUNCE_MS || 1500);
const STOP_RE = /^\s*(stop|unsubscribe|band karo|mat bhejo|no more messages)\s*$/i;

// ---------------------------------------------------------------------------
// Per-lead serial queue
// ---------------------------------------------------------------------------
const leadQueues = new Map();
function runExclusive(leadId, task) {
  const key = String(leadId);
  const prev = leadQueues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  leadQueues.set(key, next);
  next.finally(() => {
    if (leadQueues.get(key) === next) leadQueues.delete(key);
  });
  return next;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scoreOnly(lead, conversation) {
  return analyzeConversationAsync({ leadId: lead._id, conversationId: conversation._id }).catch((err) =>
    logger.error(`[ai] Lead scoring failed for lead ${lead._id}`, { error: err.message }),
  );
}

async function handleInbound({ conversation, lead, message }) {
  return runExclusive(lead._id, () => handleInboundLocked({ conversation, lead, message }));
}

async function handleInboundLocked({ conversation, lead, message }) {
  // Manual takeover / closed chat — the team is handling it themselves.
  if (conversation.status === "manual" || conversation.status === "closed") return scoreOnly(lead, conversation);

  const settings = await settingsService.getOrCreateSettings();
  const config = salesAgent.getAgentConfig(settings);
  if (settings.aiPaused || !settings.autoReplyEnabled || !config.enabled) return scoreOnly(lead, conversation);
  if (settings.whatsappDisconnected) return scoreOnly(lead, conversation);

  // Debounce: if the customer sends several messages quickly, answer once.
  if (DEBOUNCE_MS > 0) await sleep(DEBOUNCE_MS);
  const latestInbound = await Message.findOne({ conversationId: conversation._id, direction: "inbound" })
    .sort({ timestamp: -1, _id: -1 })
    .select("_id")
    .lean();
  if (message?._id && latestInbound && String(latestInbound._id) !== String(message._id)) {
    logger.info(`[ai] Newer message arrived for lead ${lead._id}; replying to that one instead`);
    return;
  }

  // Always work on the freshest copy (another turn may have updated it).
  conversation = (await Conversation.findById(conversation._id)) || conversation;
  const profile = { ...(conversation.salesProfile || {}) };
  const currentText = message?.text || "";

  if (STOP_RE.test(currentText)) conversation.optedOut = true;
  else if (conversation.optedOut) conversation.optedOut = false; // they started talking again

  // ── Step 1: first contact → welcome + language buttons (no AI needed) ──
  const lang = salesAgent.detectLanguageChoice(currentText);
  if (!conversation.welcomeSent && !profile.language && !lang) {
    await sendAndRecord({
      lead,
      conversation,
      text: config.welcomeMessage,
      quickReplies: config.useButtons ? salesAgent.QUESTION_OPTIONS.language : [],
      intent: "welcome",
    });
    conversation.welcomeSent = true;
    conversation.salesStage = "language";
    conversation.markModified("salesProfile");
    await conversation.save();
    return scoreOnly(lead, conversation);
  }

  // ── Step 2: AI sales turn ──
  const apiKey = await settingsService.getGeminiKey();
  const recentMessages = await Message.find({ conversationId: conversation._id })
    .sort({ timestamp: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  recentMessages.reverse();

  let turn;
  if (!apiKey) {
    logger.warn(`[ai] No Gemini API key — scripted sales reply for lead ${lead._id}`);
    const fb = salesAgent.scriptedFallback({ ...profile, ...(lang ? { language: lang } : {}) });
    turn = {
      ...fb,
      media: [],
      profileUpdates: { ...salesAgent.matchOptionAnswers(currentText), ...(lang ? { language: lang } : {}) },
      usedFallback: true,
    };
  } else {
    turn = await salesAgent.runSalesTurn({
      apiKey,
      config,
      lead,
      profile,
      history: recentMessages,
      mediaAlreadySent: conversation.mediaSent || [],
    });
  }

  // ── Step 3: send reply + media ──
  let outbound;
  try {
    outbound = await sendAndRecord({
      lead,
      conversation,
      text: turn.reply,
      quickReplies: turn.quickReplies,
      aiPrompt: turn.systemInstruction,
      aiResponseRaw: turn.raw ? { model: turn.model, response: turn.raw } : null,
      intent: turn.stage,
    });
  } catch (err) {
    logger.error(`[ai] Failed to send sales reply to lead ${lead._id}`, {
      error: err.metaError || err.response?.data || err.message,
    });
    await Notification.create({
      userId: conversation.ownerId,
      type: "whatsapp_send_failed",
      title: `Couldn't message ${lead.name || "lead"} — WhatsApp send failed`,
      body: `Sending via WhatsApp failed for ${lead.phone}: ${err.message}`,
      link: `/whatsapp/conversations`,
    });
    emitToUser(conversation.ownerId, "notification:new", { leadId: lead._id });
    return;
  }

  const sentKeys = new Set(conversation.mediaSent || []);
  for (const item of turn.media || []) {
    try {
      await sendMediaItem({ lead, conversation, item });
      sentKeys.add(item.key);
    } catch (err) {
      logger.error(`[ai] Failed to send sales media "${item.key}" to lead ${lead._id}`, {
        error: err.metaError || err.message,
        url: salesAgent.resolveMediaUrl(item.url),
      });
    }
  }
  conversation.mediaSent = [...sentKeys];

  // ── Step 4: save what we learned ──
  const updates = turn.profileUpdates || {};
  const newProfile = { ...profile, ...updates };
  if (turn.leadClass) newProfile.leadClass = turn.leadClass;
  if (turn.nextAction) newProfile.nextAction = turn.nextAction;
  if (turn.stage) newProfile.stage = turn.stage;
  newProfile.updatedAt = new Date().toISOString();
  conversation.salesProfile = newProfile;
  conversation.markModified("salesProfile");
  conversation.salesStage = turn.stage || conversation.salesStage;
  conversation.lastIntent = turn.stage || null;
  conversation.welcomeSent = true;
  if (turn.optOut) conversation.optedOut = true;

  await syncLead({ lead, profile: newProfile });

  if (turn.demoRequested || newProfile.preferredDemoDate) {
    newProfile.demoInterest = newProfile.demoInterest || "yes";
    if (newProfile.preferredDemoDate && newProfile.preferredDemoTime) {
      await createDemoRequest({
        lead,
        conversation,
        date: newProfile.preferredDemoDate,
        time: newProfile.preferredDemoTime,
        profile: newProfile,
      });
    }
  }

  if (turn.wantsHuman) {
    await alertTeam({
      lead,
      conversation,
      title: `🙋 ${lead.name || lead.phone} wants to talk to a human`,
      body: newProfile.nextAction || "Prospect asked for a call / human. Reach out now.",
      config,
    });
  }
  if (turn.usedFallback) {
    await Notification.create({
      userId: conversation.ownerId,
      type: "ai_fallback",
      title: `AI was busy — scripted reply sent to ${lead.name || lead.phone}`,
      body: "Gemini was unavailable after retries on every model. A safe scripted reply was sent. Check this chat.",
      link: `/whatsapp/conversations`,
    }).catch(() => {});
  }

  await conversation.save();

  emitToUser(conversation.ownerId, "conversation:aiReply", {
    conversationId: conversation._id,
    leadId: lead._id,
    message: outbound,
  });

  scoreOnly(lead, conversation);
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

async function sendAndRecord({ lead, conversation, text, quickReplies = [], aiPrompt, aiResponseRaw, intent }) {
  // Short human-like pause.
  await sleep(400 + Math.floor(Math.random() * 500));
  const { messageId } = await metaWhatsappClient.sendReplyWithOptions({
    phone: lead.phone,
    text,
    options: quickReplies,
  });
  return recordOutboundMessage({
    conversationId: conversation._id,
    leadId: lead._id,
    text,
    sender: "ai",
    whatsappMessageId: messageId || null,
    aiPrompt,
    aiResponseRaw,
    intent,
    quickReplies,
  });
}

async function sendMediaItem({ lead, conversation, item }) {
  const url = salesAgent.resolveMediaUrl(item.url);
  let result;
  if (item.type === "document") {
    result = await metaWhatsappClient.sendDocumentMessage({
      phone: lead.phone,
      documentUrl: url,
      filename: `${(item.title || item.key).replace(/[^\w\- ]+/g, "")}.pdf`,
      caption: item.caption || item.title,
    });
  } else if (item.type === "video") {
    result = await metaWhatsappClient.sendVideoMessage({ phone: lead.phone, videoUrl: url, caption: item.caption || item.title });
  } else {
    result = await metaWhatsappClient.sendImageMessage({ phone: lead.phone, imageUrl: url, caption: item.caption || item.title });
  }
  return recordOutboundMessage({
    conversationId: conversation._id,
    leadId: lead._id,
    text: item.caption || item.title || `[${item.type}]`,
    sender: "ai",
    whatsappMessageId: result?.messageId || null,
    mediaUrl: url,
    mediaType: item.type || "image",
    intent: "media",
  });
}

async function syncLead({ lead, profile }) {
  const $set = { salesProfile: profile };
  if (profile.name && (!lead.name || /^WhatsApp\s/i.test(lead.name))) $set.name = profile.name;
  if (profile.businessName) $set.businessName = profile.businessName;
  if (profile.email && /.+@.+\..+/.test(profile.email)) $set.email = profile.email.toLowerCase();
  if (profile.city) $set.city = profile.city;
  if (profile.businessType) $set.occupation = profile.businessType;
  const summary = [
    profile.businessType && `Business: ${profile.businessType}`,
    profile.leadVolume && `Leads/month: ${profile.leadVolume}`,
    profile.mainChallenge && `Challenge: ${profile.mainChallenge}`,
    profile.currentProcess && `Process: ${profile.currentProcess}`,
    profile.preferredDemoDate && `Demo: ${profile.preferredDemoDate} ${profile.preferredDemoTime || ""}`.trim(),
  ]
    .filter(Boolean)
    .join(" · ");
  if (summary) $set.requirements = summary;
  const qualified = profile.businessType && profile.leadVolume && profile.mainChallenge;
  if (qualified && ["new", "contacted"].includes(lead.status)) $set.status = "qualified";
  if (!qualified && lead.status === "new") $set.status = "contacted";
  try {
    await Lead.updateOne({ _id: lead._id }, { $set });
  } catch (err) {
    logger.warn(`[ai] Could not sync sales profile to lead ${lead._id}`, { error: err.message });
  }
}

async function alertTeam({ lead, conversation, title, body, config }) {
  await Notification.create({
    userId: conversation.ownerId,
    type: "sales_alert",
    title,
    body,
    link: `/whatsapp/conversations`,
  }).catch(() => {});
  emitToUser(conversation.ownerId, "notification:new", { leadId: lead._id });
  if (config?.handoffPhone) {
    metaWhatsappClient
      .sendTextMessage({
        phone: config.handoffPhone,
        text: `${title}\nPhone: ${lead.phone}\n${body}`,
      })
      .catch((err) => logger.warn("[ai] Team WhatsApp alert failed (24h window?)", { error: err.message }));
  }
}

/**
 * Demo request = a Meeting row (status "scheduled") with source whatsapp_ai.
 * The bot tells the prospect the team will CONFIRM — the team sees it on the
 * Demos page. One active demo per lead; a new time updates it.
 */
async function createDemoRequest({ lead, conversation, date, time, profile = {} }) {
  let meeting = await Meeting.findOne({
    leadId: lead._id,
    status: { $in: ["scheduled", "rescheduled"] },
  }).sort({ createdAt: -1 });

  if (meeting && meeting.preferredDate === date && meeting.preferredTime === time) return meeting;

  const notes = [
    "PropAI demo request (via WhatsApp AI)",
    profile.businessName && `Business: ${profile.businessName}`,
    profile.businessType && `Type: ${profile.businessType}`,
    profile.leadVolume && `Leads/month: ${profile.leadVolume}`,
    profile.mainChallenge && `Challenge: ${profile.mainChallenge}`,
  ]
    .filter(Boolean)
    .join("\n");

  const isNew = !meeting;
  if (meeting) {
    meeting.preferredDate = date;
    meeting.preferredTime = time;
    meeting.status = meeting.status === "scheduled" ? "scheduled" : "rescheduled";
    meeting.notes = notes;
    await meeting.save();
  } else {
    meeting = await Meeting.create({
      leadId: lead._id,
      ownerId: conversation.ownerId,
      preferredDate: date,
      preferredTime: time,
      status: "scheduled",
      source: "whatsapp_ai",
      conversationId: conversation._id,
      notes,
    });
  }
  conversation.meetingStatus = "proposed";
  await Lead.updateOne({ _id: lead._id }, { $set: { status: "site_visit" } }); // "site_visit" = demo stage in the CRM

  try {
    const summary = `PropAI Demo — ${profile.businessName || lead.name || lead.phone}`;
    const description = `${notes}\nPhone: ${lead.phone}\nRequested by the prospect on WhatsApp — please confirm.`;
    const event = meeting.googleEventId
      ? await updateCalendarEvent({ eventId: meeting.googleEventId, date, time })
      : await createCalendarEvent({ summary, description, date, time });
    if (event) {
      if (event.eventId) meeting.googleEventId = event.eventId;
      meeting.googleEventLink = event.eventLink;
      await meeting.save();
    }
  } catch (err) {
    logger.warn(`[calendar] Demo calendar sync skipped for lead ${lead._id}`, { error: err.message });
  }

  const settings = await settingsService.getOrCreateSettings();
  await alertTeam({
    lead,
    conversation,
    title: `${isNew ? "📅 New demo request" : "🔁 Demo time changed"} — ${profile.name || profile.businessName || lead.name || lead.phone}`,
    body: `${date} at ${time}. Please confirm and send the meeting link.`,
    config: salesAgent.getAgentConfig(settings),
  });
  emitToUser(conversation.ownerId, "meeting:created", { meeting });
  return meeting;
}

/** Backwards-compatible name used by older code paths (manual scheduling). */
async function createSiteVisit({ lead, conversation, date, time }) {
  const d = date || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return createDemoRequest({ lead, conversation, date: d, time: time || "11:00", profile: conversation.salesProfile || {} });
}

/**
 * Sends the very first outbound WhatsApp message to a lead.
 *
 * Ab yeh function queue worker (services/queue/bulkWorker.js) ke liye
 * banaya gaya hai, isliye:
 *   - Success par        -> { sent: true, usedTemplate }
 *   - Skip karna pade to -> { skipped: true, reason }
 *       reasons: not_ai_active | already_started | ai_paused | whatsapp_disconnected
 *   - Koi bhi ERROR par  -> THROW karta hai (err.code / err.metaError ke saath),
 *       taaki worker retry ya fail decide kar sake. Yahan koi error nigla nahi jata.
 *
 * Idempotent: agar outbound message pehle se ja chuka hai to dobara nahi bhejta
 * (isse retry par double message nahi jayega).
 */
async function startConversation({ lead, conversation, templateOverride = null, outboundJobId = null }) {
  if (!templateOverride && conversation.status !== "ai_active") {
    return { skipped: true, reason: "not_ai_active" };
  }

  // Campaign template messages are intentionally allowed for previously-contacted leads.
  // Use the durable job ID for idempotency instead of blocking every lead that ever had a message.
  const alreadyStarted = templateOverride && outboundJobId
    ? await Message.exists({ outboundJobId })
    : (!templateOverride ? await Message.exists({ conversationId: conversation._id, direction: "outbound" }) : false);
  if (alreadyStarted) return { skipped: true, reason: "already_started", sent: true };

  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.phoneNumberId) {
    const err = new Error(
      "Meta WhatsApp Cloud API is not configured (META_WHATSAPP_ACCESS_TOKEN / META_WHATSAPP_PHONE_NUMBER_ID)",
    );
    err.code = "META_NOT_CONFIGURED";
    throw err;
  }

  const settings = await settingsService.getOrCreateSettings();
  if (!templateOverride && (settings.aiPaused || !settings.autoReplyEnabled)) {
    return { skipped: true, reason: "ai_paused" };
  }
  if (settings.whatsappDisconnected) {
    return { skipped: true, reason: "whatsapp_disconnected" };
  }

  const openingText =
    settings.openingText ||
    env.metaWhatsapp.openingText ||
    settings.greetingMessage ||
    "👋 Hey! Welcome to PropAI by Deific Digital. Aap kis language mein baat karna prefer karenge — Hindi, Hinglish ya English? 😊";

  let outbound = null;
  let usedTemplate = false;

  try {
    const lastInboundAt = conversation.lastInboundAt
      ? new Date(conversation.lastInboundAt)
      : null;

    const isWindowOpen =
      lastInboundAt &&
      !Number.isNaN(lastInboundAt.getTime()) &&
      Date.now() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000;

    if (templateOverride?.name) {
      const variables = Array.isArray(templateOverride.variables) ? templateOverride.variables : [];
      const maxIndex = variables.reduce((max, item) => Math.max(max, Number(item.index) || 0), 0);
      const parameters = [];
      for (let index = 1; index <= maxIndex; index += 1) {
        const variable = variables.find((item) => Number(item.index) === index);
        let value = "";
        if (variable?.source === "name") value = lead.name || "";
        else if (variable?.source === "phone") value = lead.phone || "";
        else if (variable?.source === "email") value = lead.email || "";
        else value = variable?.value || "";
        parameters.push({ type: "text", text: String(value || "Customer").slice(0, 1024) });
      }
      const components = [];
      if (parameters.length) components.push({ type: "body", parameters });
      if (templateOverride.headerImageUrl) {
        components.unshift({ type: "header", parameters: [{ type: "image", image: { link: templateOverride.headerImageUrl } }] });
      }
      const { messageId } = await metaWhatsappClient.sendTemplateMessage({
        phone: lead.phone,
        templateName: templateOverride.name,
        languageCode: templateOverride.language || "en_US",
        components,
      });
      // Store the actual message body in CRM history instead of the internal
      // template key. This lets brokers understand what the customer received.
      const fillVars = (text) => String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, number) => {
        const parameter = parameters[Number(number) - 1];
        return parameter?.text || '';
      });
      const bodyPreview = fillVars(templateOverride.body);
      // Full message as the customer sees it: header, body, footer and buttons
      // (WhatsApp *bold* / _italic_ markers are rendered by the chat screen).
      const messagePreview = bodyPreview.trim()
        ? [
            templateOverride.header ? `*${fillVars(templateOverride.header).trim()}*` : '',
            bodyPreview.trim(),
            templateOverride.footer ? `_${templateOverride.footer.trim()}_` : '',
            (templateOverride.buttons || []).filter(Boolean).map((label) => `[ ${label} ]`).join('\n'),
          ].filter(Boolean).join('\n\n')
        : `Template sent: ${templateOverride.name}`;
      outbound = await recordOutboundMessage({
        conversationId: conversation._id,
        leadId: lead._id,
        text: messagePreview,
        sender: "ai",
        whatsappMessageId: messageId || null,
        outboundJobId,
      });
      usedTemplate = true;
      logger.info(`[campaign] Approved WhatsApp template sent for lead ${lead._id}`, {
        templateName: templateOverride.name,
        templateLanguage: templateOverride.language,
        campaignJobId: outboundJobId ? String(outboundJobId) : null,
      });
    } else if (isWindowOpen) {
      // Customer ne last 24 hours mein message kiya hai: normal text allowed.
      const { messageId } = await metaWhatsappClient.sendTextMessage({
        phone: lead.phone,
        text: openingText,
      });

      outbound = await recordOutboundMessage({
        conversationId: conversation._id,
        leadId: lead._id,
        text: openingText,
        sender: "ai",
        whatsappMessageId: messageId || null,
      });

      logger.info(
        `[ai] Opening text sent via Meta Cloud API for lead ${lead._id}`,
        { phone: lead.phone, reason: "24h-window-open" },
      );
      conversation.welcomeSent = true; // opening text already asks the language
    } else {
      // New lead / closed 24-hour window: approved template first.
      // ENV value takes priority over an old template saved in Settings.
      const templateName =
        env.metaWhatsapp.openingTemplateName || settings.openingTemplate?.name;

      const templateLanguage =
        env.metaWhatsapp.openingTemplateLanguage ||
        settings.openingTemplate?.language;

      if (!templateName) {
        const err = new Error(
          "Opening template is not configured. Set META_WHATSAPP_OPENING_TEMPLATE_NAME.",
        );
        err.code = "OPENING_TEMPLATE_MISSING";
        throw err;
      }

      const components = [];

      // Use this only if the approved template has an IMAGE header.
      const imageUrl = process.env.META_WHATSAPP_OPENING_TEMPLATE_IMAGE_URL;

      if (imageUrl) {
        components.push({
          type: "header",
          parameters: [
            {
              type: "image",
              image: { link: imageUrl },
            },
          ],
        });
      }

      const { messageId } = await metaWhatsappClient.sendTemplateMessage({
        phone: lead.phone,
        templateName,
        languageCode: templateLanguage,
        components,
      });

      outbound = await recordOutboundMessage({
        conversationId: conversation._id,
        leadId: lead._id,
        text: `[Template: ${templateName}]`,
        sender: "ai",
        whatsappMessageId: messageId || null,
      });

      usedTemplate = true;

      logger.info(`[ai] Opening WhatsApp template sent for lead ${lead._id}`, {
        templateName,
        templateLanguage,
        reason: "24h-window-closed",
      });
    }
  } catch (err) {
    logger.error(
      `[ai] Failed to send opening WhatsApp message for lead ${lead._id}`,
      {
        error: err.metaError || err.response?.data || err.message,
        code: err.code,
        phone: lead.phone,
      },
    );
    // IMPORTANT: error ko nigalna nahi hai — worker ko pata chalna chahiye.
    throw err;
  }

  conversation.templateSent = usedTemplate;
  conversation.templateSentAt = usedTemplate ? new Date() : null;
  conversation.lastMessageAt = new Date();
  await conversation.save();

  emitToUser(conversation.ownerId, "conversation:aiReply", {
    conversationId: conversation._id,
    leadId: lead._id,
    message: outbound,
  });

  return { sent: true, usedTemplate };
}

/**
 * Broker ke woh leads dhundhta hai jinka conversation ai_active hai lekin
 * abhi tak koi message nahi gaya, aur unhe QUEUE mein daal deta hai.
 * (Ab seedha message nahi bhejta — isse 100+ leads par parallel burst nahi hoga.)
 *
 * Skip karta hai:
 *   - jinka message pehle se ja chuka hai
 *   - jinka job pehle 'failed' ya 'cancelled' ho chuka hai
 *     (warna har server restart par woh dobara queue mein aa jate)
 *   - jinka job abhi pending/processing/paused hai (enqueueLeads khud handle karta hai)
 */
async function catchUpPendingConversations(brokerId) {
  const pending = await Conversation.find({
    ownerId: brokerId,
    status: "ai_active",
  })
    .select("_id leadId")
    .lean();
  if (!pending.length) return;

  const conversationIds = pending.map((c) => c._id);
  const leadIds = pending.map((c) => c.leadId);

  const [withMessages, blockedLeadIds] = await Promise.all([
    Message.distinct("conversationId", {
      conversationId: { $in: conversationIds },
    }),
    // failed/cancelled jobs, ya koi bhi campaign job: campaign leads ka schedule
    // campaign khud sambhalta hai (e.g. email-only campaign ki lead ko
    // restart par WhatsApp nahi jana chahiye).
    OutboundJob.distinct("leadId", {
      leadId: { $in: leadIds },
      $or: [
        { status: { $in: ["failed", "cancelled"] } },
        { campaignId: { $ne: null } },
      ],
    }),
  ]);

  const hasMessageSet = new Set(withMessages.map(String));
  const blockedSet = new Set(blockedLeadIds.map(String));

  const toQueue = pending
    .filter(
      (c) =>
        !hasMessageSet.has(String(c._id)) && !blockedSet.has(String(c.leadId)),
    )
    .map((c) => c.leadId);

  if (!toQueue.length) return;

  const { queued } = await enqueueLeads({
    ownerId: brokerId,
    leadIds: toQueue,
  });

  if (queued) {
    logger.info(
      `[ai] Catch-up: ${queued} pending conversation(s) queued for broker ${brokerId}`,
    );
  }
}

module.exports = {
  handleInbound,
  createSiteVisit,
  createDemoRequest,
  startConversation,
  catchUpPendingConversations,
};
