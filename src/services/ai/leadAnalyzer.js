const Lead = require('../../models/Lead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const LeadScore = require('../../models/LeadScore');
const FollowUp = require('../../models/FollowUp');
const Notification = require('../../models/Notification');

const settingsService = require('../settings/settingsService');
const { generateStructured } = require('./geminiClient');
const { emitToUser } = require('../../sockets');
const logger = require('../../utils/logger');
const metaWhatsappClient = require('../whatsapp/metaWhatsappClient');
const EmailMessage = require('../../models/EmailMessage');
const { levelForScore, LEAD_SCORE, HOT_SCORE } = require('../../config/leadRules');

const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '0-100 lead quality score' },
    level: { type: 'string', enum: ['cold', 'warm', 'hot'] },
    interestLevel: { type: 'string' },
    buyingIntent: { type: 'string' },
    budgetMatch: { type: 'boolean' },
    closingProbability: { type: 'number', description: '0-100' },
    summary: { type: 'string', description: '2-3 sentence summary of the buyer and where the conversation stands.' },
    reason: { type: 'string', description: 'Why this score was given.' },
    nextFollowUpDate: { type: 'string', description: 'ISO date (YYYY-MM-DD) for the next follow-up.' },
    nextFollowUpMessage: { type: 'string', description: 'A draft opening line for the next follow-up message.' },
    urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
    buyingProbability: { type: 'number', description: '0-100' },
  },
  required: ['score', 'level', 'summary', 'reason', 'nextFollowUpDate', 'nextFollowUpMessage', 'urgency'],
};

function buildAnalysisPrompt(lead) {
  const profile = lead.salesProfile || {};
  return `You are a B2B SaaS sales analyst for PropAI by Deific Digital (AI lead management & WhatsApp automation software for real estate businesses).
You are reviewing the WhatsApp/email conversation between the PropAI sales assistant and a prospect named ${lead.name}.
Known qualification: ${JSON.stringify(profile)}

Scoring scale used by the CRM: 0-${LEAD_SCORE} = cold (no real interest yet), ${LEAD_SCORE + 1}-${HOT_SCORE} = warm (relevant business, exploring), above ${HOT_SCORE} = hot.

HOT = strong fit (builder/broker/agency/sales team), a real lead-management problem, clear demo or pricing interest, near-term intent.
WARM = relevant business, interested in features/info, needs discussion or approval.
COLD = low intent, no use case, not ready.
Do NOT mark hot only because they asked for a brochure or screenshots.

Return: score (0-100), level, interestLevel, buyingIntent, closingProbability, a 2-3 sentence summary (business type, lead volume, challenge, demo status), reason, a sensible next follow-up date (hot: 1 day, warm: 2-3 days, cold: 7 days) and a short friendly follow-up opening line in the prospect's language, urgency and buyingProbability.
Be realistic and conservative.`;
}

const POSITIVE_SIGNALS = [
  /price|pricing|cost|kitna|kitne|budget|plan|package|aed|₹|rs\.?/i,
  /demo|dikhao|walkthrough|meeting|call|zoom|meet/i,
  /builder|developer|broker|dealer|agency|sales team|channel partner/i,
  /leads?|enquir|follow.?up|crm|whatsapp|site visit/i,
  /interested|yes|haan|ha\b|ok|sure|details|brochure|screenshot|kab|when|tomorrow|kal/i,
];
const NEGATIVE_SIGNAL = /not interested|no need|nahi chahiye|mat bhejo|stop|unsubscribe|remove me|wrong number|galat number/i;

/**
 * Fallback scorer used only when no Gemini key is configured, so the lead
 * rules (score > 30 = lead, > 60 = hot) still work. Deliberately simple and
 * conservative: a single "ok" reply stays below the lead line.
 */
function heuristicAnalysis(lead, entries) {
  const replies = entries.filter((e) => e.fromCustomer).map((e) => e.text || '');
  const joined = replies.join(' \n ');
  if (NEGATIVE_SIGNAL.test(joined)) {
    return { score: 10, summary: `${lead.name || 'Customer'} ne mana kar diya / interest nahi dikhaya.`, reason: 'Negative reply detected.', urgency: 'low' };
  }
  const hits = POSITIVE_SIGNALS.filter((re) => re.test(joined)).length;
  const score = Math.min(100, 10 + Math.min(15, replies.length * 5) + hits * 12);
  const last = replies[replies.length - 1] || '';
  return {
    score,
    summary: `${lead.name || 'Customer'} ne ${replies.length} baar reply kiya. Aakhri reply: "${last.slice(0, 140)}"`,
    reason: `Keyword-based score (no AI key configured): ${hits} buying signal(s), ${replies.length} reply(s).`,
    urgency: score > HOT_SCORE ? 'high' : score > LEAD_SCORE ? 'medium' : 'low',
  };
}

/** WhatsApp + email history for one lead, oldest first. */
async function loadLeadTranscript(leadId) {
  const [waMessages, emails] = await Promise.all([
    Message.find({ leadId }).sort({ timestamp: -1 }).limit(60).lean(),
    EmailMessage.find({ leadId, status: { $nin: ['queued', 'cancelled', 'failed'] } }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  const entries = [
    ...waMessages.map((m) => ({
      at: new Date(m.timestamp || m.createdAt),
      fromCustomer: m.direction === 'inbound' && m.sender === 'customer',
      text: m.text || '',
      channel: 'WhatsApp',
    })),
    ...emails.map((e) => ({
      at: new Date(e.receivedAt || e.sentAt || e.createdAt),
      fromCustomer: e.direction === 'inbound',
      text: [e.subject ? `Subject: ${e.subject}` : '', String(e.text || '').slice(0, 1500)].filter(Boolean).join('\n'),
      channel: 'Email',
    })),
  ];
  return entries.sort((a, b) => a.at - b.at);
}

/** Backwards-compatible entry point used by the WhatsApp conversation engine. */
// Throttle: chat turns can come every few seconds; scoring every single one
// doubles Gemini traffic (a common cause of 429/503). Run at most once per
// ANALYSIS_THROTTLE_MS per lead, with one trailing run so the latest
// messages are always scored.
const ANALYSIS_THROTTLE_MS = Number(process.env.LEAD_ANALYSIS_THROTTLE_MS || 45000);
const analysisState = new Map(); // leadId -> { lastRun, timer }

async function analyzeConversationAsync({ leadId, conversationId }) {
  const key = String(leadId);
  const state = analysisState.get(key) || { lastRun: 0, timer: null };
  const wait = state.lastRun + ANALYSIS_THROTTLE_MS - Date.now();
  if (wait > 0) {
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        state.lastRun = Date.now();
        analyzeLeadAsync({ leadId, conversationId }).catch((err) =>
          logger.error(`[ai] Deferred lead analysis failed for ${leadId}`, { error: err.message }),
        );
      }, wait);
      if (state.timer.unref) state.timer.unref();
    }
    analysisState.set(key, state);
    return;
  }
  state.lastRun = Date.now();
  analysisState.set(key, state);
  return analyzeLeadAsync({ leadId, conversationId });
}

/**
 * Scores a lead from everything they said on WhatsApp and email, then
 * persists score, temperature (cold/warm/hot from the CRM thresholds),
 * summary and the next follow-up. Leads that never replied are not scored.
 */
async function analyzeLeadAsync({ leadId, conversationId = null }) {
  const lead = await Lead.findById(leadId);
  if (!lead) return;
  const entries = await loadLeadTranscript(leadId);
  if (!entries.some((e) => e.fromCustomer)) return; // no reply yet → not a lead

  if (!conversationId) {
    const conversation = await Conversation.findOne({ leadId }).select('_id').lean();
    conversationId = conversation?._id || null;
  }

  const transcript = entries
    .map((e) => `[${e.channel}] ${e.fromCustomer ? 'Prospect' : 'PropAI Sales'}: ${e.text}`)
    .join('\n');

  let parsed;
  const apiKey = await settingsService.getGeminiKey();
  if (apiKey) {
    try {
      ({ parsed } = await generateStructured({
        apiKey,
        systemInstruction: buildAnalysisPrompt(lead),
        history: [{ role: 'user', text: transcript }],
        responseSchema: ANALYSIS_RESPONSE_SCHEMA,
        temperature: 0.3, // scoring should be consistent, not creative
      }));
    } catch (err) {
      logger.error(`[ai] Lead analysis Gemini call failed for lead ${leadId}`, { error: err.message });
    }
    // A temporary AI failure keeps the previous score instead of overwriting it.
    if (!parsed || typeof parsed.score !== 'number') return;
  }
  if (!parsed) {
    const fallback = heuristicAnalysis(lead, entries);
    const days = fallback.score > HOT_SCORE ? 1 : fallback.score > LEAD_SCORE ? 3 : 7;
    parsed = {
      ...fallback,
      nextFollowUpDate: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
      nextFollowUpMessage: `Hi ${lead.name || ''}! 👋 Aapne PropAI ke baare mein interest dikhaya tha — kya hum aapke real estate lead management ka live demo arrange karein?`.replace(/\s+!/, '!'),
      modelVersion: 'heuristic',
    };
  }

  const score = clamp(parsed.score, 0, 100);
  // The CRM thresholds decide the temperature, not the model's own label.
  parsed.level = levelForScore(score);

  await LeadScore.create({
    leadId,
    score,
    level: parsed.level,
    modelVersion: parsed.modelVersion || 'gemini',
    interestLevel: parsed.interestLevel || null,
    buyingIntent: parsed.buyingIntent || null,
    budgetMatch: parsed.budgetMatch ?? null,
    closingProbability: parsed.closingProbability != null ? clamp(parsed.closingProbability, 0, 100) : null,
    summary: parsed.summary,
    reason: parsed.reason,
  });

  const wasHotBefore = lead.status === 'hot';
  lead.leadScore = score;
  // Only auto-promote status via score for leads still in the AI-qualification
  // funnel — never downgrade/override a broker's manual closed/lost/site_visit call.
  if (!['closed', 'lost', 'site_visit'].includes(lead.status)) {
    lead.status = parsed.level; // 'cold' | 'warm' | 'hot' — all valid Lead.STATUSES values
  }
  await lead.save();

  if (conversationId) {
    await Conversation.updateOne(
      { _id: conversationId },
      { $set: { aiSummary: parsed.summary, currentLeadScore: score } }
    );
  }

  if (parsed.nextFollowUpDate) {
    await FollowUp.findOneAndUpdate(
      { leadId, status: 'pending' },
      {
        leadId,
        ownerId: lead.ownerId,
        nextFollowUpDate: new Date(parsed.nextFollowUpDate),
        nextFollowUpMessage: parsed.nextFollowUpMessage,
        urgency: parsed.urgency || 'medium',
        buyingProbability: parsed.buyingProbability != null ? clamp(parsed.buyingProbability, 0, 100) : null,
        status: 'pending',
        generatedBy: parsed.modelVersion || 'gemini',
      },
      { upsert: true, new: true }
    );
  }

  if (parsed.level === 'hot' && !wasHotBefore) {
    await Notification.create({
      userId: lead.ownerId,
      type: 'hot_lead',
      title: `🔥 Hot lead — ${lead.name}`,
      body: parsed.summary,
      link: `/qualified-leads?stage=hot`,
    });
  }

  // Alert the configured broker number once per temperature threshold. An approved
  // Meta template can be configured for deployments where free-text is not allowed.
  try {
    const settings = await settingsService.getOrCreateSettings();
    const alertPhone = String(settings.leadAlertPhone || '').trim();
    const alertEnabledForLevel = parsed.level === 'hot' || (parsed.level === 'warm' && settings.leadAlertLevel === 'hot_warm');
    const alertTimestampField = parsed.level === 'hot' ? 'hotAlertSentAt' : 'warmAlertSentAt';
    if (alertPhone && alertEnabledForLevel && !lead[alertTimestampField]) {
      // Atomic claim prevents two overlapping analysis runs from notifying twice.
      const claimedAt = new Date();
      const claim = await Lead.findOneAndUpdate(
        { _id: lead._id, [alertTimestampField]: null },
        { $set: { [alertTimestampField]: claimedAt } },
        { new: true },
      );
      if (claim) {
        const alertText = [
          `🔥 ${parsed.level.toUpperCase()} PROPAI SALES LEAD`,
          `Name: ${lead.name || 'Not provided'}`,
          `Phone: ${lead.phone || 'Not provided'}`,
          `Email: ${lead.email || 'Not provided'}`,
          `Score: ${score}/100`,
          `Business: ${lead.businessName || lead.salesProfile?.businessType || 'Not provided'}`,
          `Leads/month: ${lead.salesProfile?.leadVolume || 'Not provided'}`,
          `Summary: ${parsed.summary || parsed.reason || 'AI has identified buying intent.'}`,
        ].join('\n');
        const templateName = process.env.META_WHATSAPP_LEAD_ALERT_TEMPLATE_NAME;
        try {
          if (templateName) {
            const { messageId } = await metaWhatsappClient.sendTemplateMessage({
              phone: alertPhone,
              templateName,
              languageCode: process.env.META_WHATSAPP_LEAD_ALERT_TEMPLATE_LANGUAGE || 'en_US',
              components: [{ type: 'body', parameters: [lead.name || 'Lead', lead.phone || 'Not provided', lead.email || 'Not provided', String(score), parsed.summary || parsed.reason || 'Interested buyer'].map((value) => ({ type: 'text', text: String(value).slice(0, 1024) })) }],
            });
            logger.info(`[ai] Lead alert template sent for ${lead._id}`, { messageId, level: parsed.level });
          } else {
            const { messageId } = await metaWhatsappClient.sendTextMessage({ phone: alertPhone, text: alertText });
            logger.info(`[ai] Lead alert sent for ${lead._id}`, { messageId, level: parsed.level });
          }
        } catch (alertErr) {
          // Release the claim so a later analysis can retry after configuration/window issues are fixed.
          await Lead.updateOne({ _id: lead._id, [alertTimestampField]: claimedAt }, { $set: { [alertTimestampField]: null } });
          logger.warn(`[ai] Lead alert could not be sent for ${lead._id}; check WhatsApp 24-hour window or configure META_WHATSAPP_LEAD_ALERT_TEMPLATE_NAME`, { error: alertErr.message, code: alertErr.code });
        }
      }
    }
  } catch (alertConfigErr) {
    logger.warn('[ai] Could not evaluate configured lead alert', { error: alertConfigErr.message });
  }

  emitToUser(lead.ownerId, 'lead:scored', { leadId, score, level: parsed.level });
}

function clamp(n, min, max) {
  if (typeof n !== 'number' || Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

module.exports = { analyzeConversationAsync, analyzeLeadAsync, heuristicAnalysis };
