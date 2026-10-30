const mongoose = require('mongoose');
const { Schema } = mongoose;

const settingsSchema = new Schema(
  {
    // Single-tenant app: exactly ONE Settings document exists for the whole
    // deployment (see settingsService.getOrCreateSettings) — no organizationId.

    companyName: { type: String, default: 'PropAI', trim: true },
    logoUrl: { type: String, default: '' },

    // Encrypted at rest via app-level encryption (see utils/crypto in a later phase);
    // never returned to the client in plaintext.
    geminiApiKeyEncrypted: { type: String, default: null, select: false },

    businessHours: {
      start: { type: String, default: '09:00' },
      end: { type: String, default: '19:00' },
    },
    workingDays: {
      type: [String],
      default: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    },
    greetingMessage: {
      type: String,
      default: "Hi! 👋 Welcome to PropAI by Deific Digital — AI lead management for real estate businesses.",
    },

    // Message used when a lead is added while its WhatsApp 24-hour customer
    // service window is already open. If blank, the env fallback or
    // greetingMessage is used.
    openingText: {
      type: String,
      default: "👋 Hey! Welcome to PropAI by Deific Digital. Main aapko dikhata hoon ki PropAI aapke real estate business ki sales process ko kaise smarter bana sakta hai. Sabse pehle, aap kis language mein baat karna prefer karenge — Hindi, Hinglish ya English? 😊",
      trim: true,
    },

    aiPaused: { type: Boolean, default: false },
    autoReplyEnabled: { type: Boolean, default: true },

    // Alert the broker/team number when AI scores a lead as hot (default) or warm/hot.
    leadAlertPhone: { type: String, default: null, trim: true },
    leadAlertLevel: { type: String, enum: ['hot', 'hot_warm'], default: 'hot' },

    // Seconds the AI waits before sending its reply, kept for backwards-
    // compatibility with existing Settings documents/Settings page UI.
    // NOT strictly enforced anymore — conversationEngine.js sends every
    // reply with a fixed randomized 3-4s delay regardless of this value,
    // so it no longer needs (or should have) a narrow enum. A narrow enum
    // here was a bug: Mongoose validates the ENTIRE document on every
    // .save() call (e.g. from the Settings page, or the daily-report
    // scheduler), so any org whose stored value was the old default (5)
    // or another old option (2/10) would fail EVERY settings save with a
    // validation error the moment the enum was narrowed to [3,4].
    aiReplyDelaySeconds: { type: Number, min: 1, max: 30, default: 4 },

    // "Human Takeover" (Settings page toggle) is just a friendlier name for
    // aiPaused — kept as the same field so every place that already checks
    // settings.aiPaused (conversationEngine, etc.) keeps working unchanged.

    // Org-level WhatsApp disconnect switch. The Meta WhatsApp Cloud API
    // connection is shared infra (one META_WHATSAPP_PHONE_NUMBER_ID per
    // deployment), so "Disconnect" here doesn't touch that connection — it
    // stops THIS org's AI/manual sends and inbound auto-replies until
    // reconnected.
    whatsappDisconnected: { type: Boolean, default: false },

    // Daily WhatsApp summary — "today we talked to N leads, here are the
    // interested ones with name+phone" sent to a fixed WhatsApp number
    // every day at a configured time (broker's own number, a team lead's
    // number, a group, etc — whatever the connected WhatsApp number can
    // message). Time is HH:mm 24-hour, evaluated in Asia/Kolkata.
    dailyReportEnabled: { type: Boolean, default: false },
    dailyReportPhone: { type: String, default: null, trim: true },
    dailyReportTime: { type: String, default: '19:00' }, // HH:mm, 24hr

    // Internal bookkeeping so the once-a-minute scheduler doesn't send the
    // same day's report twice (e.g. if the server restarts right at 19:00
    // or the cron tick overlaps). Not meant to be set from the API.
    dailyReportLastSentDate: { type: String, default: null, select: false }, // 'YYYY-MM-DD'

    // Human handoff / referral closing step — "kya aap Monica ko apne kaam
    // ke liye lena chahenge?" asked once a property conversation winds down
    // and the lead seems satisfied. DB values here always win over the
    // REFERRAL_* env var fallbacks (see config/env.js). contactNumber is the
    // number actually sent to the lead once they say yes — kept out of the
    // AI's hands on purpose (see conversationEngine.js), so this is the one
    // place that controls it.
    referral: {
      enabled: { type: Boolean, default: false },
      personName: { type: String, default: 'PropAI Team', trim: true },
      contactNumber: { type: String, default: null, trim: true },
    },

    // Which approved WhatsApp message TEMPLATE opens a brand-new
    // conversation (the very first, business-initiated message to a lead —
    // required by Meta's WhatsApp Cloud API, see metaWhatsappClient.js).
    // Falls back to META_WHATSAPP_OPENING_TEMPLATE_NAME/LANGUAGE from the
    // environment when left blank here.
    // ───────────── PropAI Sales Agent (editable from the "Sales Agent" page) ─────────────
    // Blank strings mean "use the built-in default" (see services/ai/salesAgent.js),
    // so "Reset to default" in the UI simply clears the field.
    salesAgent: {
      enabled: { type: Boolean, default: true },
      agentName: { type: String, default: 'PropAI Sales Assistant', trim: true },
      companyName: { type: String, default: 'PropAI by Deific Digital', trim: true },
      systemPrompt: { type: String, default: '' },
      welcomeMessage: { type: String, default: '' },
      knowledgeBase: { type: String, default: '' },
      useButtons: { type: Boolean, default: true },
      autoSendImages: { type: Boolean, default: true },
      maxImagesPerReply: { type: Number, default: 1, min: 1, max: 3 },
      handoffPhone: { type: String, default: '', trim: true },
    },

    // Sales image / brochure / video library the agent can send during chat.
    // Empty array → built-in default templates (public/sales-media).
    salesMedia: [
      {
        _id: false,
        key: { type: String, required: true, trim: true },
        title: { type: String, default: '', trim: true },
        type: { type: String, enum: ['image', 'document', 'video'], default: 'image' },
        url: { type: String, required: true, trim: true },
        caption: { type: String, default: '', trim: true },
        whenToSend: { type: String, default: '', trim: true },
        active: { type: Boolean, default: true },
      },
    ],

    openingTemplate: {
      name: { type: String, default: null, trim: true },
      language: { type: String, default: null, trim: true },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
