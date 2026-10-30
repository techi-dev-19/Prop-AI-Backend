/**
 * PropAI Sales Agent — the brain of the WhatsApp sales chat.
 *
 *   ┌────────────── editable from the dashboard (Sales Agent page) ──────────────┐
 *   │  Master prompt  ·  Welcome message  ·  Product knowledge & pricing  ·      │
 *   │  Sales image library (images / brochure / video + "when to send")          │
 *   └────────────────────────────────────────────────────────────────────────────┘
 *                                   +
 *   ┌────────────── added automatically by code every turn ──────────────────────┐
 *   │  today's date · prospect's region · chosen language · what we already know │
 *   │  (business type, lead volume, challenge…) · media already sent · JSON rules│
 *   └────────────────────────────────────────────────────────────────────────────┘
 *
 * runSalesTurn() is a pure function (no DB writes), so it powers both the
 * real WhatsApp engine and the "Test chat" simulator on the dashboard.
 */
const fs = require("fs");
const path = require("path");
const { generateStructured } = require("./geminiClient");
const logger = require("../../utils/logger");

// ---------------------------------------------------------------------------
// DEFAULTS (used until the user edits them on the Sales Agent page)
// ---------------------------------------------------------------------------

const DEFAULT_SALES_PROMPT = fs.readFileSync(
  path.join(__dirname, "defaultSalesPrompt.md"),
  "utf8",
);

const DEFAULT_WELCOME_MESSAGE = `👋 Hey! Welcome to *PropAI by Deific Digital*.

Imagine managing your real estate enquiries, lead follow-ups and site visit bookings with AI. 🚀

Main aapko dikhata hoon ki PropAI aapke real estate business ki sales process ko kaise smarter bana sakta hai.

Sabse pehle, aap kis language mein baat karna prefer karenge? 😊`;

const DEFAULT_KNOWLEDGE = `PRODUCT: PropAI by Deific Digital — AI-powered lead management & WhatsApp automation for real estate businesses.

WHO IT IS FOR: Builders/developers, property dealers & brokers, real estate agencies, marketing agencies, channel partner networks, sales teams.

KEY CAPABILITIES (subject to package & configuration):
- AI replies to property enquiries on WhatsApp (Hindi & English)
- Hot / Warm / Cold lead scoring
- WhatsApp follow-up automation
- Bulk messaging (where supported & compliant)
- Lead management & tracking dashboard
- Site visit booking workflows
- Sales team notifications
- CRM integrations (where supported)
- Reporting & performance tracking

APPROVED PRICING:
- UAE offer: Setup AED 12,600 + starting AED 4,500 / month (quote ONLY to UAE prospects).
- India: pricing is confirmed by the sales team after understanding lead volume & team size. Do NOT quote UAE prices to Indian prospects.
- Never invent discounts, plans or custom development costs.

DEMO: Live demo over Google Meet / Zoom, ~30 minutes. Booking is confirmed by the sales team — collect preferred date & time.`;

const QUESTION_OPTIONS = {
  businessType: [
    "Builder / Developer",
    "Dealer / Broker",
    "Marketing Agency",
    "Sales Team",
    "Other Real Estate",
  ],
  leadVolume: ["0–100 leads", "100–500 leads", "500–1,000 leads", "1,000+ leads"],
  mainChallenge: [
    "Follow-ups missed",
    "WhatsApp overload",
    "Team misses leads",
    "Hot leads unclear",
    "Site visit booking",
    "Too many leads",
  ],
  currentProcess: [
    "Manually / WhatsApp",
    "Excel / Sheets",
    "CRM software",
    "Multiple tools",
    "No proper system",
  ],
  language: ["🇮🇳 Hindi", "😊 Hinglish", "🌎 English"],
  demo: ["📅 Book live demo", "📸 Show screenshots", "💰 Pricing"],
};

/**
 * Default sales image library. These ship with the backend
 * (public/sales-media) so the bot can send visuals from day one; replace
 * them with real product screenshots from the dashboard any time.
 */
const DEFAULT_MEDIA = [
  {
    key: "overview",
    title: "PropAI overview",
    type: "image",
    url: "/sales-media/propai-overview.png",
    caption: "PropAI — AI lead management for real estate 🚀",
    whenToSend: "After the prospect shares their business type or challenge, or asks what PropAI is / for details / screenshots.",
    active: true,
  },
  {
    key: "whatsapp_ai",
    title: "AI WhatsApp replies",
    type: "image",
    url: "/sales-media/propai-whatsapp-ai.png",
    caption: "AI replies to every enquiry instantly — Hindi & English 💬",
    whenToSend: "When the challenge is WhatsApp overload / slow replies, or they ask how the AI chat works.",
    active: true,
  },
  {
    key: "lead_scoring",
    title: "Hot / Warm / Cold lead scoring",
    type: "image",
    url: "/sales-media/propai-lead-scoring.png",
    caption: "Know which leads are ready to buy 🔥",
    whenToSend: "When the challenge is identifying serious buyers, high lead volume (500+), or they ask about lead scoring.",
    active: true,
  },
  {
    key: "follow_ups",
    title: "Automated follow-ups",
    type: "image",
    url: "/sales-media/propai-follow-ups.png",
    caption: "No lead left without a follow-up 🔄",
    whenToSend: "When the challenge is missed follow-ups or the team missing leads.",
    active: true,
  },
  {
    key: "site_visits",
    title: "Site visit workflow",
    type: "image",
    url: "/sales-media/propai-site-visits.png",
    caption: "From enquiry to site visit — organised 📅",
    whenToSend: "When the challenge is site visit booking, or they ask about visit scheduling.",
    active: true,
  },
  {
    key: "demo_invite",
    title: "Live demo invite",
    type: "image",
    url: "/sales-media/propai-demo.png",
    caption: "See PropAI live — 30-minute demo 🖥️",
    whenToSend: "When inviting the prospect to book a demo, or when they say 'demo dikhao'.",
    active: true,
  },
];

const LANGUAGE_RULES = {
  Hindi:
    "Reply in simple Hindi written in Devanagari script (हिंदी). Common English business words like demo, lead, WhatsApp, CRM may stay in English.",
  Hinglish:
    "Reply in Hinglish — Hindi written in Roman/English letters mixed naturally with English (e.g. 'Aapke business mein sabse badi challenge kya hai?').",
  English: "Reply in clear, friendly professional English.",
};

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

function getAgentConfig(settings = {}) {
  const sa = settings.salesAgent || {};
  const media =
    Array.isArray(settings.salesMedia) && settings.salesMedia.length
      ? settings.salesMedia
      : DEFAULT_MEDIA;
  return {
    enabled: sa.enabled !== false,
    agentName: sa.agentName || "PropAI Sales Assistant",
    companyName: sa.companyName || "PropAI by Deific Digital",
    systemPrompt: (sa.systemPrompt || "").trim() || DEFAULT_SALES_PROMPT,
    welcomeMessage: (sa.welcomeMessage || "").trim() || DEFAULT_WELCOME_MESSAGE,
    knowledgeBase: (sa.knowledgeBase || "").trim() || DEFAULT_KNOWLEDGE,
    useButtons: sa.useButtons !== false,
    autoSendImages: sa.autoSendImages !== false,
    maxImagesPerReply: Math.min(3, Math.max(1, Number(sa.maxImagesPerReply) || 1)),
    handoffPhone: sa.handoffPhone || "",
    media: media
      .map((m) => (typeof m.toObject === "function" ? m.toObject() : m))
      .filter((m) => m && m.key && m.url && m.active !== false),
  };
}

function publicBaseUrl() {
  const base =
    process.env.API_PUBLIC_URL ||
    process.env.PUBLIC_API_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${process.env.PORT || 5000}`;
  return base.replace(/\/+$/, "").replace(/\/api$/, "");
}

/** "/sales-media/x.png" → "https://your-api.com/sales-media/x.png" */
function resolveMediaUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return `${publicBaseUrl()}${url.startsWith("/") ? "" : "/"}${url}`;
}

// ---------------------------------------------------------------------------
// REGION / LANGUAGE / DETERMINISTIC ANSWER MATCHING
// ---------------------------------------------------------------------------

function detectRegion(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return "Unknown";
  if (d.startsWith("971")) return "UAE";
  if (d.startsWith("966")) return "Saudi Arabia";
  if (d.startsWith("91") || d.length === 10) return "India";
  if (d.startsWith("44")) return "UK";
  if (d.startsWith("1")) return "USA/Canada";
  return "International";
}

function detectLanguageChoice(text = "") {
  const t = String(text).toLowerCase();
  if (/hinglish/.test(t)) return "Hinglish";
  if (/hindi|हिंदी|हिन्दी/.test(t)) return "Hindi";
  if (/english|\beng\b|अंग्रेज़ी|angrezi/.test(t)) return "English";
  return null;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu, " ")
    .trim();
}

/** Exact button / list taps fill the profile without needing the AI. */
function matchOptionAnswers(text) {
  const t = norm(text);
  if (!t) return {};
  const found = {};
  for (const field of ["businessType", "leadVolume", "mainChallenge", "currentProcess"]) {
    const hit = QUESTION_OPTIONS[field].find((o) => norm(o) === t);
    if (hit) found[field] = hit;
  }
  return found;
}

// ---------------------------------------------------------------------------
// PROMPT
// ---------------------------------------------------------------------------

const PROFILE_FIELDS = [
  "language",
  "name",
  "businessName",
  "businessType",
  "city",
  "leadVolume",
  "teamSize",
  "currentProcess",
  "mainChallenge",
  "requiredFeatures",
  "pricingStatus",
  "demoInterest",
  "preferredDemoDate",
  "preferredDemoTime",
  "email",
];

const SALES_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description: "The WhatsApp message to send. Short, one main question at a time.",
    },
    quickReplies: {
      type: "array",
      items: { type: "string" },
      description: "0-6 short tappable options (max 20 characters each). Empty if not needed.",
    },
    sendMedia: {
      type: "array",
      items: { type: "string" },
      description: "Keys from the MEDIA LIBRARY to send after the reply. Usually empty or one key.",
    },
    profile: {
      type: "object",
      description: "Facts learned about the prospect so far. Omit unknown fields.",
      properties: Object.fromEntries(PROFILE_FIELDS.map((f) => [f, { type: "string" }])),
    },
    stage: {
      type: "string",
      enum: [
        "language",
        "qualifying",
        "pitch",
        "demo_offer",
        "demo_scheduling",
        "pricing",
        "objection",
        "handoff",
        "not_interested",
        "won",
      ],
    },
    leadClass: { type: "string", enum: ["hot", "warm", "cold"] },
    demoRequested: { type: "boolean" },
    wantsHuman: { type: "boolean" },
    optOut: { type: "boolean" },
    nextAction: { type: "string", description: "One line for the human sales team." },
  },
  required: ["reply", "quickReplies", "sendMedia", "stage"],
};

function todayInIndia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).format(new Date());
}

function buildSystemInstruction({ config, lead = {}, profile = {}, mediaAlreadySent = [] }) {
  const region = detectRegion(lead.phone);
  const language = profile.language;
  const known = PROFILE_FIELDS.filter((f) => profile[f]).map((f) => `- ${f}: ${profile[f]}`);
  const mediaLines = config.autoSendImages
    ? config.media.map(
        (m) =>
          `- key "${m.key}" (${m.type}) — ${m.title}. Send when: ${m.whenToSend || "relevant"}${
            mediaAlreadySent.includes(m.key) ? "  [ALREADY SENT — don't repeat unless asked]" : ""
          }`,
      )
    : [];

  return `${config.systemPrompt}

=====================================================================
RUNTIME CONTEXT (added automatically — follow it exactly)
=====================================================================
Today: ${todayInIndia()} (Asia/Kolkata)
You are: ${config.agentName}, selling ${config.companyName}.
Channel: WhatsApp chat.

PROSPECT
- WhatsApp name: ${lead.name || "unknown"}
- Region (from phone number): ${region}  → follow the pricing rules for this region.
${known.length ? known.join("\n") : "- Nothing collected yet."}

LANGUAGE
${
  language
    ? `The prospect chose ${language}. ${LANGUAGE_RULES[language] || LANGUAGE_RULES.Hinglish} Never ask the language question again unless they ask to change it.`
    : `Language not chosen yet. If the prospect's message clearly picks a language, set profile.language to exactly "Hindi", "Hinglish" or "English" and continue in it. Otherwise ask the language question with quickReplies ${JSON.stringify(QUESTION_OPTIONS.language)}.`
}

PRODUCT KNOWLEDGE & APPROVED PRICING (only facts you may state)
${config.knowledgeBase}

QUALIFICATION ORDER (skip anything already known, one question per message)
1. Business type → quickReplies ${JSON.stringify(QUESTION_OPTIONS.businessType)}
2. Monthly lead volume → ${JSON.stringify(QUESTION_OPTIONS.leadVolume)}
3. Biggest challenge → ${JSON.stringify(QUESTION_OPTIONS.mainChallenge)}
4. Current process → ${JSON.stringify(QUESTION_OPTIONS.currentProcess)}
Then explain the ONE most relevant PropAI benefit for their challenge and offer a live demo.
If the prospect asks a question, answer it first, then continue qualifying.

MEDIA LIBRARY (images/files you can send — put keys in "sendMedia")
${
  mediaLines.length
    ? mediaLines.join("\n") +
      `\nRules: send at most ${config.maxImagesPerReply} item(s) per reply, only when it genuinely helps the sale (pitching a benefit, asked for screenshots/details/brochure/demo). Mention it naturally in the reply ("Ek quick look bhej raha hoon 👇"). Never invent keys.`
    : "(no media available — sendMedia must be [])"
}
Never send or describe property listings or property photos — you sell software.

DEMO BOOKING
No live calendar is connected. When they agree to a demo, collect preferred date (convert to YYYY-MM-DD in profile.preferredDemoDate) and time (24h HH:mm in profile.preferredDemoTime), plus name / business name if missing. Set demoRequested=true. Say the PropAI team will confirm the slot and share the meeting link. NEVER say the demo is "booked" or "confirmed".

WHATSAPP STYLE
- Max ~70 words, 1-3 short paragraphs, *bold* for emphasis, a few natural emojis.
- If you give quickReplies, do NOT also write the options as a list in the reply (they appear as buttons).
- quickReplies: max 6, each under 20 characters.
- If they want a human / call → wantsHuman=true and say the team will reach out shortly.
- If they say stop / not interested → optOut or stage "not_interested", thank them politely, no more pitching.

OUTPUT: return ONLY the JSON object (reply, quickReplies, sendMedia, profile, stage, leadClass, demoRequested, wantsHuman, optOut, nextAction).`;
}

function toGeminiHistory(messages = []) {
  return messages
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      role: m.direction === "inbound" || m.role === "user" ? "user" : "model",
      text: m.text,
    }));
}

// ---------------------------------------------------------------------------
// SCRIPTED FALLBACK (used only when every Gemini model is down)
// ---------------------------------------------------------------------------

const SCRIPT = {
  businessType: {
    Hindi: "बढ़िया! 😊 पहले आपके business के बारे में थोड़ा समझना चाहूँगा। आप real estate में किस type का business करते हैं?",
    Hinglish: "Perfect! 😊 Pehle aapke business ke baare mein thoda samajhna chahunga. Aap real estate mein kis type ka business operate karte hain?",
    English: "Perfect! 😊 First, I'd love to understand your business. What type of real estate business do you run?",
  },
  leadVolume: {
    Hindi: "Great! आपको लगभग हर महीने कितनी property enquiries मिलती हैं?",
    Hinglish: "Great! Aapko approximately har month kitni property enquiries milti hain?",
    English: "Great! Roughly how many property enquiries do you get every month?",
  },
  mainChallenge: {
    Hindi: "समझ गया! 😊 आपके business में सबसे बड़ी challenge क्या है?",
    Hinglish: "Samajh gaya! 😊 Aapke business mein sabse badi challenge kya hai?",
    English: "Got it! 😊 What's the biggest challenge in your sales process right now?",
  },
  currentProcess: {
    Hindi: "अभी आप अपनी property enquiries कैसे manage करते हैं?",
    Hinglish: "Abhi aap apni property enquiries kaise manage karte hain?",
    English: "How do you manage your property enquiries today?",
  },
  demo: {
    Hindi: "धन्यवाद! 🚀 आपकी requirement के हिसाब से PropAI काफी helpful हो सकता है। क्या आप एक live demo देखना चाहेंगे? हमारी team आपसे जल्दी connect करेगी।",
    Hinglish: "Thank you! 🚀 Aapki requirement ke hisaab se PropAI kaafi helpful ho sakta hai. Kya aap ek live demo dekhna chahenge? Hamari team aapse jaldi connect karegi.",
    English: "Thank you! 🚀 Based on what you've shared, PropAI can really help. Would you like to see it in a live demo? Our team will connect with you shortly.",
  },
};

function scriptedFallback(profile = {}) {
  const lang = profile.language || "Hinglish";
  if (!profile.language) {
    return {
      reply: DEFAULT_WELCOME_MESSAGE,
      quickReplies: QUESTION_OPTIONS.language,
      stage: "language",
    };
  }
  for (const field of ["businessType", "leadVolume", "mainChallenge", "currentProcess"]) {
    if (!profile[field]) {
      return {
        reply: SCRIPT[field][lang] || SCRIPT[field].Hinglish,
        quickReplies: QUESTION_OPTIONS[field],
        stage: "qualifying",
      };
    }
  }
  return { reply: SCRIPT.demo[lang] || SCRIPT.demo.Hinglish, quickReplies: QUESTION_OPTIONS.demo, stage: "demo_offer" };
}

// ---------------------------------------------------------------------------
// MAIN TURN
// ---------------------------------------------------------------------------

function cleanProfile(p = {}) {
  const out = {};
  for (const f of PROFILE_FIELDS) {
    const v = p[f];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s || /^(unknown|n\/a|null|none|-)$/i.test(s)) continue;
    out[f] = s.slice(0, 300);
  }
  if (out.language) {
    out.language = detectLanguageChoice(out.language) || undefined;
    if (!out.language) delete out.language;
  }
  if (out.preferredDemoDate && !/^\d{4}-\d{2}-\d{2}$/.test(out.preferredDemoDate)) delete out.preferredDemoDate;
  if (out.preferredDemoTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(out.preferredDemoTime)) delete out.preferredDemoTime;
  return out;
}

function cleanQuickReplies(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((s) => String(s || "").trim()).filter(Boolean))]
    .slice(0, 10)
    .map((s) => s.slice(0, 24));
}

/**
 * Generates one sales reply.
 * @returns {Promise<{reply, quickReplies, media, profileUpdates, stage, leadClass,
 *   demoRequested, wantsHuman, optOut, nextAction, usedFallback, model, systemInstruction, raw}>}
 */
async function runSalesTurn({ apiKey, config, lead, profile = {}, history = [], mediaAlreadySent = [] }) {
  const lastUserText = [...history].reverse().find((m) => m.direction === "inbound" || m.role === "user")?.text || "";

  // Deterministic pre-fill from button taps / language words — works even if AI is down.
  const pre = { ...matchOptionAnswers(lastUserText) };
  if (!profile.language) {
    const lang = detectLanguageChoice(lastUserText);
    if (lang) pre.language = lang;
  }
  const workingProfile = { ...profile, ...pre };

  const systemInstruction = buildSystemInstruction({ config, lead, profile: workingProfile, mediaAlreadySent });

  let parsed = null;
  let raw = null;
  let model = null;
  try {
    ({ parsed, raw, model } = await generateStructured({
      apiKey,
      systemInstruction,
      history: toGeminiHistory(history),
      responseSchema: SALES_RESPONSE_SCHEMA,
      temperature: 0.6,
    }));
  } catch (err) {
    logger.error("[sales] Gemini failed — using scripted fallback", { error: err.message });
  }

  if (!parsed || !String(parsed.reply || "").trim()) {
    const fb = scriptedFallback(workingProfile);
    return {
      ...fb,
      media: [],
      profileUpdates: pre,
      leadClass: null,
      demoRequested: false,
      wantsHuman: false,
      optOut: false,
      nextAction: "AI was unavailable — scripted reply sent. Review this chat.",
      usedFallback: true,
      model: null,
      systemInstruction,
      raw: null,
    };
  }

  const profileUpdates = { ...pre, ...cleanProfile(parsed.profile) };
  if (pre.language) profileUpdates.language = pre.language; // explicit tap wins

  const maxMedia = config.autoSendImages ? config.maxImagesPerReply : 0;
  const media = (Array.isArray(parsed.sendMedia) ? parsed.sendMedia : [])
    .map((k) => config.media.find((m) => m.key === String(k).trim()))
    .filter(Boolean)
    .filter((m, i, arr) => arr.findIndex((x) => x.key === m.key) === i)
    .slice(0, maxMedia);

  return {
    reply: String(parsed.reply).trim(),
    quickReplies: config.useButtons ? cleanQuickReplies(parsed.quickReplies) : [],
    media,
    profileUpdates,
    stage: parsed.stage || "qualifying",
    leadClass: ["hot", "warm", "cold"].includes(parsed.leadClass) ? parsed.leadClass : null,
    demoRequested: !!parsed.demoRequested,
    wantsHuman: !!parsed.wantsHuman,
    optOut: !!parsed.optOut || parsed.stage === "not_interested",
    nextAction: parsed.nextAction || "",
    usedFallback: false,
    model,
    systemInstruction,
    raw,
  };
}

module.exports = {
  DEFAULT_SALES_PROMPT,
  DEFAULT_WELCOME_MESSAGE,
  DEFAULT_KNOWLEDGE,
  DEFAULT_MEDIA,
  QUESTION_OPTIONS,
  PROFILE_FIELDS,
  getAgentConfig,
  resolveMediaUrl,
  detectRegion,
  detectLanguageChoice,
  matchOptionAnswers,
  buildSystemInstruction,
  scriptedFallback,
  runSalesTurn,
  toGeminiHistory,
};
