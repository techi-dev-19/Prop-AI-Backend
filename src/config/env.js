require("dotenv").config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "5000", 10),
  clientUrl: process.env.CLIENT_URL || "http://localhost:5173",
  // When set, only this account may authenticate in the single-client deployment.
  clientEmail: String(process.env.CLIENT_EMAIL || '').trim().toLowerCase(),

  mongoUri: required("MONGO_URI", "mongodb://127.0.0.1:27017/real_estate_crm"),

  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET", "dev_access_secret_change_me"),
    refreshSecret: required(
      "JWT_REFRESH_SECRET",
      "dev_refresh_secret_change_me",
    ),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "8h",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "90d",
  },

  cookie: {
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: process.env.COOKIE_SAME_SITE || (process.env.COOKIE_SECURE === "true" ? "none" : "lax"),
    domain: process.env.COOKIE_DOMAIN || undefined,
  },

  resetTokenExpiresMin: parseInt(
    process.env.RESET_TOKEN_EXPIRES_MIN || "30",
    10,
  ),
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:5173",

  brevo: {
    apiKey: process.env.BREVO_API_KEY || null,
    fromEmail: String(process.env.BREVO_FROM_EMAIL || "").trim(),
    fromName: String(process.env.BREVO_FROM_NAME || "PropAI by Deific Digital").trim(),
    replyTo: String(process.env.EMAIL_REPLY_TO || "").trim(),
    // Brevo inbound parsing uses a dedicated receiving subdomain, separate
    // from the sending domain (for example replies.yourcompany.com).
    inboundDomain: String(process.env.EMAIL_INBOUND_DOMAIN || process.env.BREVO_INBOUND_DOMAIN || "").trim().toLowerCase(),
    webhookSecret: process.env.BREVO_WEBHOOK_SECRET || null,
    replyWindowHours: parseInt(process.env.EMAIL_REPLY_WINDOW_HOURS || "72", 10),
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  },
  encryptionKey:
    process.env.ENCRYPTION_KEY || "dev_encryption_key_change_me_in_prod",

  // Meta WhatsApp Cloud API (official, approved WhatsApp Business Platform)
  // — replaces the old Unipile integration entirely. Get these from
  // https://developers.facebook.com -> your App -> WhatsApp -> API Setup:
  //   - phoneNumberId: the "Phone number ID" (NOT the phone number itself)
  //   - businessAccountId: the WhatsApp Business Account (WABA) ID
  //   - accessToken: a PERMANENT token (System User token with
  //     whatsapp_business_messaging + whatsapp_business_management scopes —
  //     the temporary 24h token from the API Setup page is only for testing)
  //   - verifyToken: any string YOU choose, entered again when you register
  //     the webhook in the Meta App Dashboard (Webhooks -> WhatsApp Business
  //     Account -> Verify and Save) — used only for the one-time GET handshake
  //   - appSecret: your Meta App's "App Secret" (App Dashboard -> Settings ->
  //     Basic) — optional but recommended, used to verify that inbound
  //     webhook POSTs really came from Meta (X-Hub-Signature-256 header)
  metaWhatsapp: {
    appId: process.env.META_APP_ID || null,
    accessToken: process.env.META_WHATSAPP_ACCESS_TOKEN || null,
    phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || null,
    businessAccountId: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || null,
    apiVersion: process.env.META_WHATSAPP_API_VERSION || "v26.0",
    verifyToken: process.env.META_WHATSAPP_VERIFY_TOKEN || null,
    appSecret: process.env.META_WHATSAPP_APP_SECRET || null,
    autoSubscribe: process.env.META_WHATSAPP_AUTO_SUBSCRIBE !== "false",
    forwardSecret: process.env.META_WHATSAPP_FORWARD_SECRET || null,

    // The very FIRST message to a lead (before they've ever messaged us) can
    // only legally be an approved message TEMPLATE — Meta blocks free-text
    // business-initiated messages outside the 24h customer service window.
    // Get this name/language exactly as approved in Meta Business Manager ->
    // WhatsApp Manager -> Message Templates.
    openingTemplateName:
      process.env.META_WHATSAPP_OPENING_TEMPLATE_NAME || null,
    openingTemplateLanguage:
      process.env.META_WHATSAPP_OPENING_TEMPLATE_LANGUAGE || "en_US",
    openingTemplateIncludeLeadName:
      process.env.META_WHATSAPP_OPENING_TEMPLATE_INCLUDE_LEAD_NAME === "true",
    // Used when the lead's WhatsApp 24-hour customer-service window is already open.
    // In that case we can send ordinary text immediately; no template is needed.
    openingText: process.env.META_WHATSAPP_OPENING_TEXT || "",
    defaultCountryCode: process.env.META_WHATSAPP_DEFAULT_COUNTRY_CODE || "91",
  },

  // Inbound WhatsApp messages from numbers that don't match any existing
  // Lead (i.e. someone messaged the connected WhatsApp number first, before
  // ever being imported/added as a lead) get auto-created as a new Lead so
  // the AI can respond to them too. This is the broker/user account that
  // "owns" the single connected WhatsApp number for this deployment — set
  // it to that broker's User._id. If left unset, the app falls back to the
  // first admin/broker user it finds (logged once at startup-time use).
  leads: {
    defaultOwnerId: process.env.DEFAULT_LEAD_OWNER_ID || null,
  },

  // Human-handoff / referral step at the end of a satisfied property
  // conversation ("kya aap Monica ko apne kaam ke liye lena chahenge?").
  // These are just fallback defaults — the same fields are editable from the
  // Settings page (see Settings model) and DB values always win over these.
  referral: {
    enabled: process.env.REFERRAL_ENABLED === "true",
    personName: process.env.REFERRAL_PERSON_NAME || "PropAI Team",
    contactNumber: process.env.REFERRAL_CONTACT_NUMBER || null,
  },

  // Google Calendar — used to create the actual calendar event once the AI
  // confirms a site visit with a lead. Auth is via a Service Account (no
  // per-user OAuth dance needed): share the target calendar with the
  // service account's email as "Make changes to events".
  googleCalendar: {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || null,
    privateKey:
      (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n") || null,
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    timezone: process.env.GOOGLE_CALENDAR_TIMEZONE || "Asia/Kolkata",
    defaultDurationMin: parseInt(
      process.env.GOOGLE_CALENDAR_EVENT_DURATION_MIN || "45",
      10,
    ),
  },

  rateLimit: {
    windowMin: parseInt(process.env.RATE_LIMIT_WINDOW_MIN || "15", 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || "300", 10),
    authMax: parseInt(process.env.AUTH_RATE_LIMIT_MAX || "20", 10),
  },
};

module.exports = env;
