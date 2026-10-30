const axios = require("axios");
const env = require("../../config/env");
const logger = require("../../utils/logger");
const { normalizePhones } = require("../../utils/contactNormalizer");

/**
 * Thin wrapper around the official Meta WhatsApp Cloud API
 * (https://developers.facebook.com/docs/whatsapp/cloud-api).
 *
 * Replaces the old Unipile integration entirely. There is no "chat_id" or
 * per-thread session concept here like Unipile had — every send just needs
 * the buyer's phone number, and Meta itself tracks the 24-hour "customer
 * service window" per phone number on their side.
 *
 * IMPORTANT — Meta's rule that shapes this whole file:
 *   - You may send a free-text (or any non-template) message to a user ONLY
 *     within 24 hours of their LAST message to you.
 *   - Outside that window (including the very first message ever, before
 *     they've messaged you at all), you MUST send an approved message
 *     TEMPLATE. A free-text send outside the window is rejected by Meta
 *     with error code 131047 ("Re-engagement message").
 *   That's why sendTemplateMessage() and sendTextMessage() are kept as two
 *   separate functions instead of one "just send whatever" helper — the
 *   caller (conversationEngine) has to know which situation it's in.
 */

const http = axios.create({ timeout: 20_000 });

function assertConfigured() {
  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.phoneNumberId) {
    throw new Error(
      "Meta WhatsApp Cloud API is not configured — set META_WHATSAPP_ACCESS_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID in the environment",
    );
  }
}

function baseUrl() {
  return `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.phoneNumberId}`;
}

function headers() {
  return {
    Authorization: `Bearer ${env.metaWhatsapp.accessToken}`,
    "Content-Type": "application/json",
  };
}

/**
 * Normalizes a lead's stored phone number into the bare-digits, country-code
 * prefixed format the Cloud API's `to` field expects (e.g. "919876543210" —
 * no "+", no spaces/dashes). Same canonical shape used across the app for
 * storing phone numbers.
 */
function toWhatsAppNumber(phone) {
  if (!phone) throw new Error("Phone number is required");

  // Shared normalizer: strips 0 / 00 / +91 prefixes, Excel ".0" artefacts,
  // rejects 9/11-digit numbers instead of silently storing a wrong number.
  const result = normalizePhones(phone, {
    defaultCountryCode: env.metaWhatsapp.defaultCountryCode || "91",
  });
  if (!result.phone) {
    throw new Error(result.errors[0] || `Phone number "${phone}" is not valid`);
  }
  return result.phone;
}

/**
 * Sending path: numbers already stored in the DB must keep working even if
 * they would not pass today's stricter import validation, so fall back to the
 * previous digits-only behaviour instead of throwing.
 */
function toSendableNumber(phone) {
  try {
    return toWhatsAppNumber(phone);
  } catch {
    const digits = String(phone || "").replace(/[^\d]/g, "");
    if (!digits) throw new Error(`Phone number "${phone}" has no digits`);
    return digits;
  }
}

function extractMessageId(data) {
  return data?.messages?.[0]?.id || null;
}

function isWithin24HourWindow(lastInboundAt, now = Date.now()) {
  if (!lastInboundAt) return false;

  const inbound = new Date(lastInboundAt).getTime();

  if (!Number.isFinite(inbound)) return false;

  const elapsed = now - inbound;

  return elapsed >= 0 && elapsed < 24 * 60 * 60 * 1000;
}

/**
 * Sends an approved message TEMPLATE.
 *
 * This is the ONLY legal way to send the very first, business-initiated
 * message to a lead, or to re-open a conversation that has gone stale
 * past the 24-hour window.
 */
async function sendTemplateMessage({
  phone,
  templateName,
  languageCode,
  components = [],
}) {
  assertConfigured();

  if (!templateName) {
    throw new Error(
      "No WhatsApp template name configured — set META_WHATSAPP_OPENING_TEMPLATE_NAME once your template is approved in WhatsApp Manager",
    );
  }

  const payload = {
    messaging_product: "whatsapp",
    to: toSendableNumber(phone),
    type: "template",
    template: {
      name: templateName,
      language: {
        code: languageCode || env.metaWhatsapp.openingTemplateLanguage,
      },
      ...(components.length ? { components } : {}),
    },
  };

  try {
    const { data } = await http.post(`${baseUrl()}/messages`, payload, {
      headers: headers(),
    });

    return {
      messageId: extractMessageId(data),
      raw: data,
    };
  } catch (err) {
    const metaError = err.response?.data?.error;

    const message =
      metaError?.message || err.message || "Meta WhatsApp template send failed";

    const apiError = new Error(message);

    apiError.code = metaError?.code || "META_TEMPLATE_SEND_FAILED";

    apiError.metaError = metaError || null;
    apiError.response = err.response;

    throw apiError;
  }
}

/**
 * Sends a plain free-text message.
 *
 * Only valid within the 24h customer service window.
 */
async function sendTextMessage({ phone, text }) {
  assertConfigured();

  const payload = {
    messaging_product: "whatsapp",
    to: toSendableNumber(phone),
    type: "text",
    text: {
      body: text,
      preview_url: false,
    },
  };

  try {
    const { data } = await http.post(`${baseUrl()}/messages`, payload, {
      headers: headers(),
    });

    return {
      messageId: extractMessageId(data),
      raw: data,
    };
  } catch (err) {
    const metaError = err.response?.data?.error;

    // 131047 = "Message failed to send because more than 24 hours have
    // passed since the customer last replied" — surface this distinctly so
    // callers can decide whether to fall back to a template instead of just
    // logging a generic axios error.
    if (metaError?.code === 131047) {
      const windowErr = new Error(
        "WHATSAPP_24H_WINDOW_CLOSED: " +
          (metaError.message || "Re-engagement message"),
      );

      windowErr.code = "WHATSAPP_24H_WINDOW_CLOSED";
      windowErr.metaError = metaError;

      throw windowErr;
    }

    const apiError = new Error(
      metaError?.message || err.message || "Meta WhatsApp message send failed",
    );

    apiError.code = metaError?.code || "META_WHATSAPP_SEND_FAILED";

    apiError.metaError = metaError || null;
    apiError.response = err.response;

    throw apiError;
  }
}

async function sendImageMessage({ phone, imageUrl, caption }) {
  assertConfigured();

  if (!imageUrl) {
    throw new Error("Image URL is required");
  }

  const payload = {
    messaging_product: "whatsapp",
    to: toSendableNumber(phone),
    type: "image",
    image: {
      link: imageUrl,
      ...(caption ? { caption } : {}),
    },
  };

  try {
    const { data } = await http.post(`${baseUrl()}/messages`, payload, {
      headers: headers(),
    });

    return {
      messageId: extractMessageId(data),
      raw: data,
    };
  } catch (err) {
    const metaError = err.response?.data?.error;

    const message =
      metaError?.message || err.message || "Meta WhatsApp image send failed";

    const apiError = new Error(message);

    apiError.code = metaError?.code || "META_WHATSAPP_IMAGE_SEND_FAILED";

    apiError.metaError = metaError || null;
    apiError.response = err.response;

    throw apiError;
  }
}

async function sendDocumentMessage({ phone, documentUrl, filename, caption }) {
  assertConfigured();

  if (!documentUrl) {
    throw new Error("Document URL is required");
  }

  const payload = {
    messaging_product: "whatsapp",
    to: toSendableNumber(phone),
    type: "document",
    document: {
      link: documentUrl,
      ...(filename ? { filename } : {}),
      ...(caption ? { caption } : {}),
    },
  };

  try {
    const { data } = await http.post(`${baseUrl()}/messages`, payload, {
      headers: headers(),
    });

    return {
      messageId: extractMessageId(data),
      raw: data,
    };
  } catch (err) {
    const metaError = err.response?.data?.error;

    const message =
      metaError?.message || err.message || "Meta WhatsApp document send failed";

    const apiError = new Error(message);

    apiError.code = metaError?.code || "META_WHATSAPP_DOCUMENT_SEND_FAILED";

    apiError.metaError = metaError || null;
    apiError.response = err.response;

    throw apiError;
  }
}

/** Shared POST helper for the interactive / video senders below. */
async function postMessage(payload, label) {
  assertConfigured();
  try {
    const { data } = await http.post(`${baseUrl()}/messages`, payload, { headers: headers() });
    return { messageId: extractMessageId(data), raw: data };
  } catch (err) {
    const metaError = err.response?.data?.error;
    const apiError = new Error(metaError?.message || err.message || `Meta WhatsApp ${label} send failed`);
    apiError.code = metaError?.code || `META_WHATSAPP_${label.toUpperCase()}_SEND_FAILED`;
    apiError.metaError = metaError || null;
    apiError.response = err.response;
    throw apiError;
  }
}

function clip(text, max) {
  const s = String(text || "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Quick-reply BUTTONS (max 3, title max 20 chars). Inside 24h window only.
 * Customer taps arrive back as interactive.button_reply (handled in webhookHandler).
 */
async function sendButtonsMessage({ phone, body, buttons = [], footer }) {
  const list = buttons.slice(0, 3).map((title, i) => ({
    type: "reply",
    reply: { id: `qr_${i}_${Date.now().toString(36)}`, title: clip(title, 20) },
  }));
  return postMessage(
    {
      messaging_product: "whatsapp",
      to: toSendableNumber(phone),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: clip(body, 1024) },
        ...(footer ? { footer: { text: clip(footer, 60) } } : {}),
        action: { buttons: list },
      },
    },
    "buttons",
  );
}

/** LIST message (up to 10 rows, row title max 24 chars). */
async function sendListMessage({ phone, body, rows = [], buttonText = "Choose option", footer }) {
  const items = rows.slice(0, 10).map((title, i) => {
    const full = String(title || "").trim();
    return {
      id: `ql_${i}_${Date.now().toString(36)}`,
      title: clip(full, 24),
      ...(full.length > 24 ? { description: clip(full, 72) } : {}),
    };
  });
  return postMessage(
    {
      messaging_product: "whatsapp",
      to: toSendableNumber(phone),
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: clip(body, 4096) },
        ...(footer ? { footer: { text: clip(footer, 60) } } : {}),
        action: { button: clip(buttonText, 20), sections: [{ title: "Options", rows: items }] },
      },
    },
    "list",
  );
}

async function sendVideoMessage({ phone, videoUrl, caption }) {
  if (!videoUrl) throw new Error("Video URL is required");
  return postMessage(
    {
      messaging_product: "whatsapp",
      to: toSendableNumber(phone),
      type: "video",
      video: { link: videoUrl, ...(caption ? { caption } : {}) },
    },
    "video",
  );
}

/**
 * Sends a text reply with tappable options:
 *   1-3 short options → reply buttons, 4-10 → list message.
 * If the interactive send fails for any reason, falls back to plain text
 * with the options written out, so the customer always gets the message.
 * Returns { messageId, kind: 'buttons'|'list'|'text' }.
 */
async function sendReplyWithOptions({ phone, text, options = [] }) {
  const opts = (options || []).map((o) => String(o || "").trim()).filter(Boolean);
  if (opts.length) {
    try {
      if (opts.length <= 3 && opts.every((o) => o.length <= 20)) {
        const r = await sendButtonsMessage({ phone, body: text, buttons: opts });
        return { ...r, kind: "buttons" };
      }
      const r = await sendListMessage({ phone, body: text, rows: opts });
      return { ...r, kind: "list" };
    } catch (err) {
      // fall through to plain text
      require("../../utils/logger").warn("[whatsapp] Interactive send failed, using plain text", {
        error: err.metaError || err.message,
      });
    }
  }
  const body = opts.length ? `${text}\n\n${opts.map((o) => `• ${o}`).join("\n")}` : text;
  const r = await sendTextMessage({ phone, text: body });
  return { ...r, kind: "text" };
}

/**
 * Single entry point for an ongoing conversation reply.
 *
 * It intentionally sends plain text only.
 */
async function sendToLead({ phone, text }) {
  const { messageId, raw } = await sendTextMessage({
    phone,
    text,
  });

  return {
    messageId,
    raw,
  };
}

/**
 * Marks an inbound message as "read" (blue ticks).
 */
async function markAsRead(whatsappMessageId) {
  if (!whatsappMessageId) return;

  assertConfigured();

  try {
    await http.post(
      `${baseUrl()}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: whatsappMessageId,
      },
      {
        headers: headers(),
      },
    );
  } catch (err) {
    logger.warn("[meta-whatsapp] Failed to mark message as read (non-fatal)", {
      error: err.response?.data || err.message,
    });
  }
}

/**
 * Shows the WhatsApp typing indicator for the incoming message.
 *
 * IMPORTANT:
 * - Uses the existing env.metaWhatsapp.phoneNumberId.
 * - Uses the existing baseUrl() and headers().
 * - Failure is non-fatal and will NEVER stop the AI reply.
 */
async function sendTypingIndicator(messageId) {
  if (!messageId) return;

  assertConfigured();

  try {
    await http.post(
      `${baseUrl()}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: {
          type: "text",
        },
      },
      {
        headers: headers(),
      },
    );

    logger.info("[whatsapp] Typing indicator sent", {
      messageId,
    });
  } catch (err) {
    logger.warn("[whatsapp] Failed to send typing indicator", {
      messageId,
      error: err.message,
      response: err.response?.data,
    });
  }
}

/**
 * GET /{phone_number_id}
 *
 * Used by the Settings page's "WhatsApp Settings" panel.
 */
async function getAccountInfo() {
  assertConfigured();

  const { data } = await http.get(
    `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.phoneNumberId}`,
    {
      headers: headers(),
      params: {
        fields:
          "display_phone_number,verified_name,quality_rating,code_verification_status",
      },
    },
  );

  return {
    phoneNumber: data?.display_phone_number || null,
    verifiedName: data?.verified_name || null,
    status: data?.code_verification_status || null,
    qualityRating: data?.quality_rating || null,
    raw: data,
  };
}

/**
 * Ensures this Meta app is subscribed to the configured WABA so Meta
 * can deliver inbound messages/status webhooks to our webhook URL.
 */
async function ensureWabaSubscription() {
  assertConfigured();

  if (!env.metaWhatsapp.businessAccountId) {
    throw new Error("META_WHATSAPP_BUSINESS_ACCOUNT_ID is not configured");
  }

  try {
    const { data } = await http.post(
      `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/subscribed_apps`,
      {},
      {
        headers: headers(),
      },
    );

    return data;
  } catch (err) {
    const metaError = err.response?.data?.error;

    const apiError = new Error(
      metaError?.message ||
        err.message ||
        "Failed to subscribe Meta app to WhatsApp Business Account",
    );

    apiError.code = metaError?.code || "META_WABA_SUBSCRIBE_FAILED";

    apiError.metaError = metaError || null;
    apiError.response = err.response;

    throw apiError;
  }
}

async function getWabaPhoneNumbers() {
  assertConfigured();

  if (!env.metaWhatsapp.businessAccountId) {
    throw new Error("META_WHATSAPP_BUSINESS_ACCOUNT_ID is not configured");
  }

  try {
    const { data } = await http.get(
      `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/phone_numbers`,
      {
        headers: headers(),
      },
    );

    return data;
  } catch (err) {
    const metaError = err.response?.data?.error;

    const apiError = new Error(
      metaError?.message || err.message || "Failed to read WABA phone numbers",
    );

    apiError.code = metaError?.code || "META_WABA_PHONE_NUMBERS_FAILED";

    apiError.metaError = metaError || null;
    apiError.response = err.response;

    throw apiError;
  }
}

async function verifyConfiguration() {
  const account = await getAccountInfo();

  let wabaPhoneNumbers = null;

  if (env.metaWhatsapp.businessAccountId) {
    wabaPhoneNumbers = await getWabaPhoneNumbers();
  }

  const ids = (wabaPhoneNumbers?.data || []).map((item) => String(item.id));

  return {
    account,
    wabaPhoneNumbers,

    phoneNumberBelongsToWaba: env.metaWhatsapp.businessAccountId
      ? ids.includes(String(env.metaWhatsapp.phoneNumberId))
      : null,
  };
}

module.exports = {
  sendTemplateMessage,
  sendTextMessage,
  sendDocumentMessage,
  sendImageMessage,
  sendVideoMessage,
  sendButtonsMessage,
  sendListMessage,
  sendReplyWithOptions,
  sendToLead,
  markAsRead,
  sendTypingIndicator,
  getAccountInfo,
  toWhatsAppNumber,
  isWithin24HourWindow,
  ensureWabaSubscription,
  getWabaPhoneNumbers,
  verifyConfiguration,
};
