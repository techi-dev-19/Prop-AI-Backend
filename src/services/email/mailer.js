const axios = require("axios");
const crypto = require("crypto");
const env = require("../../config/env");
const logger = require("../../utils/logger");

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const http = axios.create({ timeout: 20_000 });

function isBrevoConfigured() {
  return Boolean(env.brevo?.apiKey && env.brevo?.fromEmail);
}

function getFromAddress() {
  const email = String(env.brevo?.fromEmail || "").trim();
  const name = String(env.brevo?.fromName || "").trim();
  if (!email) return "";
  return name ? `${name} <${email}>` : email;
}

function assertBrevoConfigured() {
  if (!env.brevo?.apiKey || !env.brevo?.fromEmail) {
    const err = new Error("Brevo is not configured. Set BREVO_API_KEY and BREVO_FROM_EMAIL.");
    err.code = "BREVO_NOT_CONFIGURED";
    throw err;
  }
}

function normalizeApiError(err) {
  if (String(err?.code || "").startsWith("BREVO_") && !err?.response) return err;
  const status = Number(err?.response?.status || 0) || undefined;
  const responseData = err?.response?.data;
  const providerMessage = responseData?.message || responseData?.error || responseData?.code;
  const result = new Error(String(providerMessage || err?.message || "Brevo email request failed").slice(0, 500));
  result.status = status;
  result.response = err.response;
  result.providerError = responseData || null;
  result.code = status === 401 || status === 403
    ? "BREVO_AUTH_ERROR"
    : status === 429
      ? "BREVO_RATE_LIMIT"
      : status >= 500
        ? "BREVO_TEMPORARY_ERROR"
        : (responseData?.code || "BREVO_API_ERROR");
  return result;
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTemplate(text = "", vars = {}) {
  return String(text).replace(/{{\s*(\w+)\s*}}/g, (_, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : "",
  );
}

function textToHtml(text = "") {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.55">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function normalizeEmailAddress(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const email = (match?.[1] || raw).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error("A valid recipient email address is required.");
    err.code = "BREVO_INVALID_RECIPIENT";
    throw err;
  }
  return email;
}

function normalizeReplyTo(value) {
  if (!String(value || "").trim()) return undefined;
  const email = normalizeEmailAddress(value);
  if (!email || !email.includes("@")) return undefined;
  const match = String(value || "").match(/^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  return match?.[1]
    ? { email: match[2], name: match[1].replace(/^['"]|['"]$/g, "").trim() }
    : { email };
}

function normalizeTags(tags = []) {
  const normalized = (Array.isArray(tags) ? tags : [tags])
    .map((tag) => {
      if (typeof tag === "string") return tag;
      if (tag && typeof tag === "object") {
        const name = String(tag.name || "tag").trim();
        const value = String(tag.value ?? "").trim();
        return value ? `${name}_${value}` : name;
      }
      return "";
    })
    .filter(Boolean)
    .map((tag) => tag.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50));
  return [...new Set(normalized)].slice(0, 10);
}

// Brevo's transactional API accepts custom headers in the message body. Do not
// pass RFC standard headers that Brevo does not support as custom headers.
function normalizeCustomHeaders(headers = {}) {
  const allowed = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (/^x-[a-z0-9-]+$/i.test(name) && value != null) {
      allowed[name] = String(value).slice(0, 500);
    }
  }
  return allowed;
}

async function sendViaBrevo(payload, idempotencyKey) {
  assertBrevoConfigured();
  const requestBody = {
    sender: {
      email: env.brevo.fromEmail,
      ...(env.brevo.fromName ? { name: env.brevo.fromName } : {}),
    },
    ...payload,
  };

  if (idempotencyKey) {
    requestBody.headers = {
      ...(requestBody.headers || {}),
      // Stored as a message header for traceability. Brevo's API does not offer
      // the provider-side idempotency guarantee. This custom header is trace metadata only.
      "X-PropAI-Request-Key": String(idempotencyKey).slice(0, 200),
    };
  }

  try {
    const { data } = await http.post(BREVO_URL, requestBody, {
      headers: {
        "api-key": env.brevo.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    const messageId = data?.messageId || data?.messageIds?.[0];
    if (!messageId) {
      const err = new Error("Brevo response did not include a messageId");
      err.code = "BREVO_INVALID_RESPONSE";
      throw err;
    }
    return { messageId, providerMessageId: messageId, rfcMessageId: messageId, raw: data };
  } catch (err) {
    throw normalizeApiError(err);
  }
}

async function sendPasswordResetEmail(toEmail, resetLink) {
  const subject = "Reset your password";
  const htmlContent = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1e293b">
      <p>We received a request to reset your password.</p>
      <p><a href="${escapeHtml(resetLink)}">Click here to reset your password</a></p>
      <p>This link expires in ${env.resetTokenExpiresMin} minutes. If you didn't request this, you can ignore this email.</p>
    </div>`;

  if (!isBrevoConfigured()) {
    if (env.nodeEnv !== "production") {
      logger.info(`[mailer] (development only) Password reset requested for ${toEmail}; Brevo is not configured.`);
      logger.info("[mailer] Set BREVO_API_KEY and BREVO_FROM_EMAIL to deliver password-reset emails.");
      return;
    }
    assertBrevoConfigured();
  }

  const idempotencyKey = `password-reset-${crypto.createHash("sha256").update(`${toEmail}:${resetLink}`).digest("hex")}`;
  await sendViaBrevo({
    to: [{ email: toEmail }],
    subject,
    htmlContent,
    textContent: `Reset your password: ${resetLink}`,
    ...(normalizeReplyTo(env.brevo.replyTo) ? { replyTo: normalizeReplyTo(env.brevo.replyTo) } : {}),
  }, idempotencyKey);
}

/** One lead / one email API send. Body is plain text and converted to safe HTML. */
async function sendCampaignEmail({ to, subject, body, imageUrl = "", vars = {}, companyName = "", replyTo, idempotencyKey, tags = [] }) {
  const finalSubject = renderTemplate(subject, vars);
  const finalBody = renderTemplate(body, vars);
  const footer = companyName ? `${companyName}\n` : "";
  const unsubscribeNote = "Agar aap ye emails nahi chahte to kripya sender se contact karke unsubscribe request karein.";
  const htmlContent = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e293b">
      ${imageUrl && /^https:\/\//i.test(imageUrl) ? `<img src="${escapeHtml(imageUrl)}" alt="Property image" style="display:block;max-width:100%;height:auto;border-radius:10px;margin:0 0 20px;" />` : ""}
      ${textToHtml(finalBody)}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
      <p style="font-size:12px;color:#64748b;line-height:1.5">${escapeHtml(footer)}${escapeHtml(unsubscribeNote)}</p>
    </div>`;
  const selectedReplyTo = normalizeReplyTo(replyTo || env.brevo.replyTo);
  const payload = {
    to: [{ email: normalizeEmailAddress(to) }],
    subject: finalSubject,
    htmlContent,
    textContent: `${finalBody}\n\n--\n${footer}${unsubscribeNote}`,
    ...(selectedReplyTo ? { replyTo: selectedReplyTo } : {}),
    ...(tags.length ? { tags: normalizeTags(tags) } : {}),
  };
  return sendViaBrevo(payload, idempotencyKey);
}

async function sendDirectEmail({ to, subject, text = "", html, replyTo, headers = {}, tags = [], idempotencyKey }) {
  const payload = {
    to: [{ email: normalizeEmailAddress(to) }],
    subject,
    ...(text ? { textContent: text } : {}),
    ...(html ? { htmlContent: html } : {}),
    ...(normalizeReplyTo(replyTo || env.brevo.replyTo) ? { replyTo: normalizeReplyTo(replyTo || env.brevo.replyTo) } : {}),
    ...(Object.keys(normalizeCustomHeaders(headers)).length ? { headers: normalizeCustomHeaders(headers) } : {}),
    ...(tags.length ? { tags: normalizeTags(tags) } : {}),
  };
  return sendViaBrevo(payload, idempotencyKey);
}

function makeReplyAddress(trackingId) {
  const inboundDomain = String(env.brevo?.inboundDomain || "").trim().toLowerCase();
  if (!inboundDomain) return env.brevo?.replyTo || "";
  const domain = inboundDomain.replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `reply+${String(trackingId || "").replace(/[^a-f0-9]/gi, "")}@${domain}`;
}

module.exports = {
  sendPasswordResetEmail,
  sendCampaignEmail,
  sendDirectEmail,
  renderTemplate,
  isBrevoConfigured,
  getFromAddress,
  makeReplyAddress,
};
