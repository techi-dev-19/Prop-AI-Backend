const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const settingsService = require("../services/settings/settingsService");
const salesAgent = require("../services/ai/salesAgent");
const { modelChain } = require("../services/ai/geminiClient");
const logger = require("../utils/logger");

const MEDIA_DIR = path.join(__dirname, "..", "..", "public", "sales-media");
const UPLOAD_DIR = path.join(MEDIA_DIR, "uploads");

function withResolvedUrls(media) {
  return media.map((m) => ({ ...m, resolvedUrl: salesAgent.resolveMediaUrl(m.url) }));
}

function plain(doc) {
  return doc && typeof doc.toObject === "function" ? doc.toObject() : doc || {};
}

async function buildPayload() {
  const settings = await settingsService.getOrCreateSettings();
  const pub = await settingsService.getPublicSettings();
  const stored = plain(settings.salesAgent);
  const config = salesAgent.getAgentConfig(settings);
  const storedMedia = (settings.salesMedia || []).map(plain);
  return {
    salesAgent: {
      enabled: config.enabled,
      agentName: config.agentName,
      companyName: config.companyName,
      // Show the effective text so the editor is never empty.
      systemPrompt: stored.systemPrompt || salesAgent.DEFAULT_SALES_PROMPT,
      welcomeMessage: stored.welcomeMessage || salesAgent.DEFAULT_WELCOME_MESSAGE,
      knowledgeBase: stored.knowledgeBase || salesAgent.DEFAULT_KNOWLEDGE,
      useButtons: config.useButtons,
      autoSendImages: config.autoSendImages,
      maxImagesPerReply: config.maxImagesPerReply,
      handoffPhone: config.handoffPhone,
      usingDefaultPrompt: !stored.systemPrompt,
    },
    media: withResolvedUrls(storedMedia.length ? storedMedia : salesAgent.DEFAULT_MEDIA),
    usingDefaultMedia: !storedMedia.length,
    defaults: {
      systemPrompt: salesAgent.DEFAULT_SALES_PROMPT,
      welcomeMessage: salesAgent.DEFAULT_WELCOME_MESSAGE,
      knowledgeBase: salesAgent.DEFAULT_KNOWLEDGE,
      media: withResolvedUrls(salesAgent.DEFAULT_MEDIA),
    },
    questionOptions: salesAgent.QUESTION_OPTIONS,
    models: modelChain(),
    geminiKeyConfigured: !!pub.geminiKeyConfigured || !!process.env.GEMINI_API_KEY,
    aiPaused: !!settings.aiPaused,
  };
}

/** GET /api/sales-agent */
const getConfig = asyncHandler(async (req, res) => {
  return new ApiResponse(200, await buildPayload()).send(res);
});

const TEXT_LIMITS = { systemPrompt: 60000, welcomeMessage: 1000, knowledgeBase: 20000, agentName: 80, companyName: 120, handoffPhone: 20 };

/** PUT /api/sales-agent  — body: { salesAgent?: {...}, media?: [...] } */
const updateConfig = asyncHandler(async (req, res) => {
  const settings = await settingsService.getOrCreateSettings();
  const input = req.body?.salesAgent || {};
  const current = plain(settings.salesAgent);
  const next = { ...current };

  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (input[field] === undefined) continue;
    const value = String(input[field] ?? "");
    if (value.length > max) throw ApiError.badRequest(`${field} is too long (max ${max} characters)`);
    next[field] = value;
  }
  // Saving the exact default text is stored as "" so future default updates apply.
  if (next.systemPrompt && next.systemPrompt.trim() === salesAgent.DEFAULT_SALES_PROMPT.trim()) next.systemPrompt = "";
  if (next.welcomeMessage && next.welcomeMessage.trim() === salesAgent.DEFAULT_WELCOME_MESSAGE.trim()) next.welcomeMessage = "";
  if (next.knowledgeBase && next.knowledgeBase.trim() === salesAgent.DEFAULT_KNOWLEDGE.trim()) next.knowledgeBase = "";

  for (const flag of ["enabled", "useButtons", "autoSendImages"]) {
    if (input[flag] !== undefined) next[flag] = !!input[flag];
  }
  if (input.maxImagesPerReply !== undefined) {
    next.maxImagesPerReply = Math.min(3, Math.max(1, Number(input.maxImagesPerReply) || 1));
  }
  settings.salesAgent = next;

  if (Array.isArray(req.body?.media)) {
    const seen = new Set();
    settings.salesMedia = req.body.media.slice(0, 40).map((m, i) => {
      let key = String(m.key || m.title || `media_${i + 1}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || `media_${i + 1}`;
      while (seen.has(key)) key = `${key}_${i + 1}`;
      seen.add(key);
      const url = String(m.url || "").trim();
      if (!url) throw ApiError.badRequest(`Media "${m.title || key}" needs a URL or uploaded file`);
      return {
        key,
        title: String(m.title || key).slice(0, 120),
        type: ["image", "document", "video"].includes(m.type) ? m.type : "image",
        url: url.slice(0, 1000),
        caption: String(m.caption || "").slice(0, 900),
        whenToSend: String(m.whenToSend || "").slice(0, 500),
        active: m.active !== false,
      };
    });
  }

  await settings.save();
  return new ApiResponse(200, await buildPayload(), "Sales agent saved").send(res);
});

/** POST /api/sales-agent/reset — body: { fields: ['systemPrompt','welcomeMessage','knowledgeBase','media'] } */
const resetDefaults = asyncHandler(async (req, res) => {
  const settings = await settingsService.getOrCreateSettings();
  const fields = Array.isArray(req.body?.fields) ? req.body.fields : ["systemPrompt"];
  const sa = plain(settings.salesAgent);
  for (const f of fields) {
    if (["systemPrompt", "welcomeMessage", "knowledgeBase"].includes(f)) sa[f] = "";
  }
  settings.salesAgent = sa;
  if (fields.includes("media")) settings.salesMedia = [];
  await settings.save();
  return new ApiResponse(200, await buildPayload(), "Reset to default").send(res);
});

/**
 * POST /api/sales-agent/test-chat
 * body: { messages: [{ role: 'user'|'model', text }], profile: {}, phone, draft?: { systemPrompt, welcomeMessage, knowledgeBase } }
 * Runs the real sales brain without WhatsApp, so prompts can be tested from the dashboard.
 * `draft` lets the user test unsaved edits.
 */
const testChat = asyncHandler(async (req, res) => {
  const settings = await settingsService.getOrCreateSettings();
  const config = salesAgent.getAgentConfig(settings);
  const draft = req.body?.draft || {};
  for (const f of ["systemPrompt", "welcomeMessage", "knowledgeBase"]) {
    if (typeof draft[f] === "string" && draft[f].trim()) config[f] = draft[f];
  }
  if (typeof draft.useButtons === "boolean") config.useButtons = draft.useButtons;
  if (typeof draft.autoSendImages === "boolean") config.autoSendImages = draft.autoSendImages;
  if (Array.isArray(draft.media)) {
    config.media = draft.media.filter((m) => m && m.key && m.url && m.active !== false);
  }

  const messages = (Array.isArray(req.body?.messages) ? req.body.messages : [])
    .slice(-20)
    .map((m) => ({ role: m.role === "model" ? "model" : "user", text: String(m.text || "").slice(0, 2000) }))
    .filter((m) => m.text.trim());
  const profile = req.body?.profile && typeof req.body.profile === "object" ? req.body.profile : {};
  const mediaSent = Array.isArray(req.body?.mediaSent) ? req.body.mediaSent : [];
  const lead = { name: "Test Prospect", phone: String(req.body?.phone || "919800000000") };
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.text || "";

  // First message → welcome + language buttons, exactly like WhatsApp.
  const isFirst = !messages.some((m) => m.role === "model");
  if (isFirst && !profile.language && !salesAgent.detectLanguageChoice(lastUser)) {
    return new ApiResponse(200, {
      reply: config.welcomeMessage,
      quickReplies: config.useButtons ? salesAgent.QUESTION_OPTIONS.language : [],
      media: [],
      profile: { ...profile },
      stage: "language",
      model: null,
      usedFallback: false,
      welcome: true,
    }).send(res);
  }

  const apiKey = await settingsService.getGeminiKey();
  const startedAt = Date.now();
  let turn;
  if (!apiKey) {
    const fb = salesAgent.scriptedFallback({ ...profile, ...salesAgent.matchOptionAnswers(lastUser) });
    turn = { ...fb, media: [], profileUpdates: salesAgent.matchOptionAnswers(lastUser), usedFallback: true, model: null };
  } else {
    turn = await salesAgent.runSalesTurn({ apiKey, config, lead, profile, history: messages, mediaAlreadySent: mediaSent });
  }
  logger.info("[sales] test-chat turn", { model: turn.model, ms: Date.now() - startedAt, fallback: turn.usedFallback });

  return new ApiResponse(200, {
    reply: turn.reply,
    quickReplies: turn.quickReplies || [],
    media: withResolvedUrls(turn.media || []),
    profile: { ...profile, ...(turn.profileUpdates || {}) },
    stage: turn.stage,
    leadClass: turn.leadClass || null,
    demoRequested: !!turn.demoRequested,
    wantsHuman: !!turn.wantsHuman,
    nextAction: turn.nextAction || "",
    model: turn.model || null,
    usedFallback: !!turn.usedFallback,
    noApiKey: !apiKey,
    ms: Date.now() - startedAt,
  }).send(res);
});

const ALLOWED_MIME = {
  "image/png": ["image", ".png"],
  "image/jpeg": ["image", ".jpg"],
  "image/webp": ["image", ".webp"],
  "application/pdf": ["document", ".pdf"],
  "video/mp4": ["video", ".mp4"],
};

/** POST /api/sales-agent/upload (multipart field "file") → { url, type } */
const uploadMedia = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest("File is required (field name: file)");
  const info = ALLOWED_MIME[req.file.mimetype];
  if (!info) throw ApiError.badRequest("Upload a PNG, JPG, WEBP image, a PDF brochure or an MP4 video");
  const [type, ext] = info;

  // 1) Cloudinary if configured — gives a public HTTPS URL WhatsApp can fetch.
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    try {
      const { uploadBufferToCloudinary } = require("../services/cloudinaryUpload");
      const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
        folder: "propai/sales-media",
        resourceType: type === "document" ? "raw" : type === "video" ? "video" : "image",
      });
      return new ApiResponse(201, { url: uploaded.secure_url, type, storage: "cloudinary" }, "Uploaded").send(res);
    } catch (err) {
      logger.warn("[sales] Cloudinary upload failed, saving locally", { error: err.message });
    }
  }

  // 2) Local disk fallback, served at /sales-media/uploads/… (set API_PUBLIC_URL so WhatsApp can reach it).
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.file.buffer);
  const url = `/sales-media/uploads/${name}`;
  return new ApiResponse(
    201,
    { url, resolvedUrl: salesAgent.resolveMediaUrl(url), type, storage: "local" },
    "Uploaded",
  ).send(res);
});

module.exports = { getConfig, updateConfig, resetDefaults, testChat, uploadMedia, MEDIA_DIR };
