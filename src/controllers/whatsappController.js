// const asyncHandler = require("../utils/asyncHandler");
// const WhatsAppTemplateAsset = require('../models/WhatsAppTemplateAsset');
// const ApiError = require("../utils/ApiError");
// const ApiResponse = require("../utils/ApiResponse");
// const env = require("../config/env");
// const metaWhatsappClient = require("../services/whatsapp/metaWhatsappClient");
// const { handleWebhook } = require("../services/whatsapp/webhookHandler");
// const settingsService = require("../services/settings/settingsService");
// const logger = require("../utils/logger");
// const axios = require("axios");

// /**
//  * GET /api/whatsapp/webhook
//  * One-time handshake Meta performs when you register/verify the webhook URL
//  * in the Meta App Dashboard (WhatsApp -> Configuration -> Webhook).
//  *
//  * Meta sends:
//  * hub.mode=subscribe
//  * hub.verify_token=<the token entered in Meta Dashboard>
//  * hub.challenge=<random string>
//  *
//  * If the token matches, echo hub.challenge back as plain text.
//  */

// const verifyWebhook = asyncHandler(async (req, res) => {
//   // Parse query parameters directly from the request URL.
//   // This avoids relying on Express's req.query parser.
//   const queryString = (req.originalUrl || req.url).split("?")[1] || "";
//   const params = new URLSearchParams(queryString);

//   const mode = params.get("hub.mode")?.trim();
//   const token = params.get("hub.verify_token")?.trim();
//   const challenge = params.get("hub.challenge")?.trim();

//   const configuredToken = env.metaWhatsapp.verifyToken;

//   if (
//     mode === "subscribe" &&
//     configuredToken &&
//     token === configuredToken &&
//     challenge
//   ) {
//     logger.info("[whatsapp] Webhook verification succeeded");

//     return res.status(200).type("text/plain").send(challenge);
//   }

//   // Do not log the actual verify token.
//   logger.warn("[whatsapp] Webhook verification failed", {
//     modeReceived: mode || null,
//     tokenReceived: Boolean(token),
//     tokenConfigured: Boolean(configuredToken),
//     challengeReceived: Boolean(challenge),
//     requestUrlHasQuery: queryString.length > 0,
//   });

//   return res.sendStatus(403);
// });

// // const verifyWebhook = asyncHandler(async (req, res) => {
// //   // Express may return an array when query parameters are repeated.
// //   const getQueryValue = (value) => {
// //     const normalizedValue = Array.isArray(value) ? value[0] : value;

// //     return typeof normalizedValue === "string"
// //       ? normalizedValue.trim()
// //       : normalizedValue;
// //   };

// //   const mode = getQueryValue(req.query["hub.mode"]);
// //   const token = getQueryValue(req.query["hub.verify_token"]);
// //   const challenge = getQueryValue(req.query["hub.challenge"]);

// //   const configuredToken = env.metaWhatsapp.verifyToken;

// //   if (
// //     mode === "subscribe" &&
// //     configuredToken &&
// //     token === configuredToken &&
// //     challenge
// //   ) {
// //     logger.info("[whatsapp] Webhook verification succeeded");
// //     return res.status(200).type("text/plain").send(challenge);
// //   }

// //   // Never log the actual verify token.
// //   logger.warn("[whatsapp] Webhook verification failed", {
// //     modeReceived: mode,
// //     tokenReceived: Boolean(token),
// //     tokenConfigured: Boolean(configuredToken),
// //     challengeReceived: Boolean(challenge),
// //     tokenType: Array.isArray(req.query["hub.verify_token"])
// //       ? "array"
// //       : typeof req.query["hub.verify_token"],
// //   });

// //   return res.sendStatus(403);
// // });

// /**
//  * POST /api/whatsapp/webhook
//  * Public endpoint (no auth) — this is the URL you register in the Meta App
//  * Dashboard under WhatsApp -> Configuration -> Webhook, subscribed to the
//  * "messages" field.
//  *
//  * Always responds 200 quickly; Meta retries on anything else.
//  */
// const receiveWebhook = asyncHandler(async (req, res) => {
//   logger.info(`[whatsapp] Webhook hit: object=${req.body?.object}`);

//   // Respond immediately. AI processing may take longer than Meta's
//   // expected webhook response time.
//   res.status(200).json({ ok: true });

//   handleWebhook(req.body).catch((err) =>
//     logger.error("[whatsapp] Unhandled webhook processing error", {
//       error: err.message,
//     }),
//   );
// });

// /**
//  * POST /api/whatsapp/webhook/forward
//  *
//  * Optional bridge for deployments where the SAME Meta App webhook is already
//  * owned by n8n. n8n can forward the raw Meta JSON to this endpoint with
//  * X-PropAI-Webhook-Secret.
//  *
//  * This endpoint intentionally does not require a user JWT because it is
//  * machine-to-machine. Keep the secret private.
//  */
// const receiveForwardedWebhook = asyncHandler(async (req, res) => {
//   if (!env.metaWhatsapp.forwardSecret) {
//     return res.sendStatus(404);
//   }

//   const supplied = req.get("X-PropAI-Webhook-Secret");

//   if (!supplied || supplied !== env.metaWhatsapp.forwardSecret) {
//     return res.sendStatus(401);
//   }

//   logger.info(`[whatsapp] Forwarded webhook hit: object=${req.body?.object}`);

//   res.status(200).json({ ok: true });

//   handleWebhook(req.body).catch((err) =>
//     logger.error("[whatsapp] Unhandled forwarded webhook processing error", {
//       error: err.message,
//     }),
//   );
// });

// /**
//  * POST /api/whatsapp/send-test
//  *
//  * Manual/dev utility to confirm the Meta WhatsApp Cloud API integration can
//  * actually send.
//  *
//  * Like every free-text send, this only works within 24h of the target number
//  * having messaged your WhatsApp number at least once.
//  *
//  * Use send-test-template below to reach a brand-new number.
//  */
// const sendTest = asyncHandler(async (req, res) => {
//   const { phone, text } = req.body;

//   if (!phone || !text) {
//     throw ApiError.badRequest("phone and text are required");
//   }

//   const settings = await settingsService.getOrCreateSettings();

//   if (settings.whatsappDisconnected) {
//     throw ApiError.badRequest(
//       "WhatsApp is disconnected for your account — reconnect it from Settings first",
//     );
//   }

//   const { messageId } = await metaWhatsappClient.sendTextMessage({
//     phone,
//     text,
//   });

//   return new ApiResponse(200, { messageId }, "Message sent").send(res);
// });

// /**
//  * POST /api/whatsapp/send-test-template
//  *
//  * Dev utility to send the configured opening TEMPLATE to any number,
//  * bypassing the 24h window rule.
//  *
//  * Useful to confirm the approved template works before wiring it into the
//  * real lead-creation flow.
//  */
// const sendTestTemplate = asyncHandler(async (req, res) => {
//   const { phone } = req.body;

//   if (!phone) {
//     throw ApiError.badRequest("phone is required");
//   }

//   const settings = await settingsService.getOrCreateSettings();

//   const templateName =
//     settings.openingTemplate?.name || env.metaWhatsapp.openingTemplateName;

//   const templateLanguage =
//     settings.openingTemplate?.language ||
//     env.metaWhatsapp.openingTemplateLanguage;

//   if (!templateName) {
//     throw ApiError.badRequest(
//       "No approved WhatsApp opening template is configured",
//     );
//   }

//   const { messageId } = await metaWhatsappClient.sendTemplateMessage({
//     phone,
//     templateName,
//     languageCode: templateLanguage,
//   });

//   return new ApiResponse(200, { messageId }, "Template message sent").send(res);
// });

// /**
//  * GET /api/whatsapp/diagnostics
//  *
//  * Verifies the configured sender and WABA mapping.
//  */
// const diagnostics = asyncHandler(async (req, res) => {
//   const configured = Boolean(
//     env.metaWhatsapp.accessToken &&
//     env.metaWhatsapp.phoneNumberId &&
//     env.metaWhatsapp.businessAccountId,
//   );

//   if (!configured) {
//     throw ApiError.badRequest("Meta WhatsApp credentials are incomplete");
//   }

//   try {
//     const result = await metaWhatsappClient.verifyConfiguration();

//     return new ApiResponse(
//       200,
//       {
//         provider: "meta_cloud_api",
//         apiVersion: env.metaWhatsapp.apiVersion,
//         phoneNumberId: env.metaWhatsapp.phoneNumberId,
//         businessAccountId: env.metaWhatsapp.businessAccountId,
//         phoneNumberBelongsToWaba: result.phoneNumberBelongsToWaba,
//         sender: result.account,
//         wabaPhoneNumbers: result.wabaPhoneNumbers,
//       },
//       "Meta WhatsApp configuration verified",
//     ).send(res);
//   } catch (err) {
//     return new ApiResponse(
//       502,
//       {
//         provider: "meta_cloud_api",
//         phoneNumberId: env.metaWhatsapp.phoneNumberId,
//         businessAccountId: env.metaWhatsapp.businessAccountId,
//         ok: false,
//         metaError: err.metaError ||
//           err.response?.data?.error || {
//             message: err.message,
//             code: err.code,
//           },
//       },
//       "Meta WhatsApp configuration verification failed",
//     ).send(res);
//   }
// });

// /**
//  * GET /api/whatsapp/status
//  *
//  * Reports whether Meta WhatsApp Cloud API is configured, the connected
//  * number (best-effort, straight from Meta), and whether this org has hit
//  * "Disconnect" on the Settings page.
//  */
// const getStatus = asyncHandler(async (req, res) => {
//   const configured = Boolean(
//     env.metaWhatsapp.accessToken && env.metaWhatsapp.phoneNumberId,
//   );

//   const settings = await settingsService.getOrCreateSettings();

//   let phoneNumber = null;
//   let verifiedName = null;
//   let liveStatus = null;
//   let qualityRating = null;

//   if (configured) {
//     try {
//       const info = await metaWhatsappClient.getAccountInfo();

//       phoneNumber = info.phoneNumber;
//       verifiedName = info.verifiedName;
//       liveStatus = info.status;
//       qualityRating = info.qualityRating;
//     } catch (err) {
//       logger.warn(
//         "[whatsapp] Could not fetch Meta account info for status page",
//         {
//           error: err.response?.data || err.message,
//         },
//       );
//     }
//   }

//   return new ApiResponse(200, {
//     provider: "meta_cloud_api",
//     configured,
//     phoneNumberId: configured ? env.metaWhatsapp.phoneNumberId : null,
//     businessAccountId: env.metaWhatsapp.businessAccountId,
//     apiVersion: env.metaWhatsapp.apiVersion,
//     phoneNumber,
//     verifiedName,
//     liveStatus,
//     qualityRating,
//     openingTemplateConfigured: Boolean(
//       settings.openingTemplate?.name || env.metaWhatsapp.openingTemplateName,
//     ),
//     openingTemplateName:
//       settings.openingTemplate?.name ||
//       env.metaWhatsapp.openingTemplateName ||
//       null,
//     openingTemplateLanguage:
//       settings.openingTemplate?.language ||
//       env.metaWhatsapp.openingTemplateLanguage,
//     disconnected: settings.whatsappDisconnected,
//   }).send(res);
// });

// /**
//  * POST /api/whatsapp/disconnect
//  *
//  * Stops AI auto-replies and manual/test sends for this org.
//  * Does NOT touch the underlying Meta WhatsApp number.
//  */
// const disconnect = asyncHandler(async (req, res) => {
//   const settings = await settingsService.updateSettings({
//     whatsappDisconnected: true,
//   });

//   return new ApiResponse(200, { settings }, "WhatsApp disconnected").send(res);
// });

// /**
//  * POST /api/whatsapp/reconnect
//  */
// const reconnect = asyncHandler(async (req, res) => {
//   const settings = await settingsService.updateSettings({
//     whatsappDisconnected: false,
//   });

//   return new ApiResponse(200, { settings }, "WhatsApp reconnected").send(res);
// });

// async function fetchMetaTemplates() {
//   if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.businessAccountId) {
//     throw ApiError.badRequest("Meta WhatsApp access token aur Business Account ID configure karein.");
//   }
//   const all = [];
//   let url = `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/message_templates`;
//   let params = { fields: "name,language,status,category,components,rejected_reason", limit: 100 };
//   // A few bounded pages are enough for this client's template catalogue and avoid an unbounded API loop.
//   for (let page = 0; url && page < 5; page += 1) {
//     const response = await axios.get(url, {
//       params,
//       headers: { Authorization: `Bearer ${env.metaWhatsapp.accessToken}` },
//       timeout: 15000,
//     });
//     all.push(...(response.data?.data || []));
//     url = response.data?.paging?.next || null;
//     params = undefined;
//   }
//   return all.map((item) => ({
//     id: item.id || null,
//     name: item.name,
//     language: item.language,
//     category: item.category || "",
//     status: item.status || "UNKNOWN",
//     rejectedReason: item.rejected_reason && item.rejected_reason !== "NONE" ? item.rejected_reason : "",
//     components: item.components || [],
//   }));
// }

// async function addTemplateAssets(templates, ownerId) {
//   const assets = await WhatsAppTemplateAsset.find({ ownerId }).lean();
//   const byKey = new Map(assets.map((asset) => [`${asset.name}::${asset.language}`, asset]));
//   return templates.map((template) => {
//     const asset = byKey.get(`${template.name}::${template.language}`);
//     return { ...template, imageUrl: asset?.imageUrl || '', bodyText: asset?.bodyText || ((template.components || []).find((part) => String(part.type).toUpperCase() === 'BODY')?.text || '') };
//   });
// }

// async function uploadTemplateImageToMeta(imageUrl) {
//   if (!env.metaWhatsapp.appId) throw ApiError.badRequest('Image-header Meta templates ke liye backend META_APP_ID bhi configure karein. Cloudinary upload URL ko Meta template sample ke roop mein submit karne ke liye App ID zaroori hai.');
//   let parsedUrl;
//   try { parsedUrl = new URL(imageUrl); } catch { throw ApiError.badRequest('Header image must be a valid HTTPS Cloudinary URL.'); }
//   if (parsedUrl.protocol !== 'https:' || !['res.cloudinary.com', 'cloudinary.com'].includes(parsedUrl.hostname.toLowerCase())) {
//     throw ApiError.badRequest('WhatsApp template header image should be uploaded to this app first (Cloudinary HTTPS URL required).');
//   }
//   const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 8 * 1024 * 1024 });
//   const buffer = Buffer.from(imageResponse.data);
//   const mime = String(imageResponse.headers['content-type'] || 'image/jpeg').split(';')[0];
//   if (!mime.startsWith('image/')) throw ApiError.badRequest('Template header URL par valid image nahi mili.');
//   if (buffer.length > 5 * 1024 * 1024) throw ApiError.badRequest('Meta template header example image 5 MB se chhoti honi chahiye.');
//   const init = await axios.post(`https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.appId}/uploads`, null, {
//     params: { file_length: buffer.length, file_type: mime, access_token: env.metaWhatsapp.accessToken }, timeout: 20000,
//   });
//   const sessionId = init.data?.id;
//   if (!sessionId) throw ApiError.badRequest('Meta image upload session create nahi hui. META_APP_ID aur token permissions check karein.');
//   const uploaded = await axios.post(`https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${sessionId}`, buffer, {
//     headers: { Authorization: `OAuth ${env.metaWhatsapp.accessToken}`, 'Content-Type': 'application/octet-stream', file_offset: '0' }, timeout: 30000, maxBodyLength: 8 * 1024 * 1024,
//   });
//   const handle = uploaded.data?.h;
//   if (!handle) throw ApiError.badRequest('Meta se image handle nahi mila.');
//   return handle;
// }

// /** DELETE /api/whatsapp/templates/:name — delete a Meta template by name. */
// const deleteTemplate = asyncHandler(async (req, res) => {
//   const name = String(req.params?.name || '').trim().toLowerCase();
//   if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name)) {
//     throw ApiError.badRequest('Invalid template name.');
//   }
//   if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.businessAccountId) {
//     throw ApiError.badRequest('Meta WhatsApp access token aur Business Account ID configure karein.');
//   }

//   try {
//     await axios.delete(
//       `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/message_templates`,
//       {
//         params: { name },
//         headers: { Authorization: `Bearer ${env.metaWhatsapp.accessToken}` },
//         timeout: 15000,
//       },
//     );
//     await WhatsAppTemplateAsset.deleteMany({ ownerId: req.user.id, name });
//     return new ApiResponse(200, { deleted: true, name }, 'WhatsApp template deleted from Meta').send(res);
//   } catch (err) {
//     const metaError = err.response?.data?.error;
//     logger.warn('[whatsapp] Template delete failed', { name, error: metaError || err.message });
//     throw new ApiError(err.response?.status && err.response.status < 500 ? 400 : 502,
//       metaError?.error_user_msg || metaError?.message || 'Meta template delete nahi ho paya. Permissions aur template name check karein.',
//       metaError || null);
//   }
// });

// /** GET /api/whatsapp/templates — approved templates only, used by the sender. */
// const listApprovedTemplates = asyncHandler(async (req, res) => {
//   try {
//     const templates = await addTemplateAssets((await fetchMetaTemplates()).filter((item) => String(item.status).toUpperCase() === "APPROVED"), req.user.id);
//     return new ApiResponse(200, { templates, configured: true }, "Approved templates loaded").send(res);
//   } catch (err) {
//     if (err instanceof ApiError) throw err;
//     const metaError = err.response?.data?.error;
//     logger.error("[whatsapp] Could not list approved templates", { error: metaError || err.message });
//     throw new ApiError(502, metaError?.message || "Meta templates could not be loaded. Check WhatsApp permissions and WABA ID.");
//   }
// });

// /** GET /api/whatsapp/templates/all — status catalogue for the Template Manager. */
// const listAllTemplates = asyncHandler(async (req, res) => {
//   try {
//     const templates = await addTemplateAssets(await fetchMetaTemplates(), req.user.id);
//     return new ApiResponse(200, { templates, configured: true }, "WhatsApp templates loaded").send(res);
//   } catch (err) {
//     if (err instanceof ApiError) throw err;
//     const metaError = err.response?.data?.error;
//     logger.error("[whatsapp] Could not load template catalogue", { error: metaError || err.message });
//     throw new ApiError(502, metaError?.message || "Meta templates could not be loaded. Check whatsapp_business_management permission and WABA ID.");
//   }
// });

// /** POST /api/whatsapp/templates — create a template in Meta and submit it for review. */
// const createTemplate = asyncHandler(async (req, res) => {
//   if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.businessAccountId) {
//     throw ApiError.badRequest("Meta WhatsApp access token aur Business Account ID configure karein.");
//   }
//   const name = String(req.body?.name || "").trim().toLowerCase();
//   const category = String(req.body?.category || "MARKETING").trim().toUpperCase();
//   const language = String(req.body?.language || "en_US").trim();
//   const bodyText = String(req.body?.bodyText || "").trim();
//   const headerText = String(req.body?.headerText || "").trim();
//   const headerImageUrl = String(req.body?.headerImageUrl || "").trim();
//   const footerText = String(req.body?.footerText || "").trim();
//   const rawSamples = Array.isArray(req.body?.sampleValues) ? req.body.sampleValues : [];
//   if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name) || name.length > 512) {
//     throw ApiError.badRequest("Template name mein sirf lowercase letters, numbers aur single underscores use karein (e.g. property_offer_2026).");
//   }
//   if (!["MARKETING", "UTILITY"].includes(category)) throw ApiError.badRequest("Is builder mein category MARKETING ya UTILITY honi chahiye.");
//   if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(language)) throw ApiError.badRequest("Language code e.g. en_US ya hi_IN use karein.");
//   if (!bodyText || bodyText.length > 1024) throw ApiError.badRequest("Body required hai aur 1,024 characters se zyada nahi ho sakta.");
//   if (headerText.length > 60 || footerText.length > 60) throw ApiError.badRequest("Header/footer maximum 60 characters ke ho sakte hain.");
//   const bodyIndexes = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
//   if (bodyIndexes.some((value) => value < 1)) {
//     throw ApiError.badRequest("Template variables {{1}}, {{2}} jaise format mein honi chahiye.");
//   }
//   const uniqueIndexes = [...new Set(bodyIndexes)].sort((a, b) => a - b);
//   if (uniqueIndexes.some((value, index) => value !== index + 1)) {
//     throw ApiError.badRequest("Template variables sequential honi chahiye: {{1}}, {{2}}, {{3}} without gaps.");
//   }
//   const components = [];
//   if (headerImageUrl) {
//     if (!/^https:\/\//i.test(headerImageUrl)) throw ApiError.badRequest('Header image URL must use HTTPS.');
//     const headerHandle = await uploadTemplateImageToMeta(headerImageUrl);
//     components.push({ type: "HEADER", format: "IMAGE", example: { header_handle: [headerHandle] } });
//   } else if (headerText) {
//     components.push({ type: "HEADER", format: "TEXT", text: headerText });
//   }
//   const bodyComponent = { type: "BODY", text: bodyText };
//   const variableCount = bodyIndexes.length ? Math.max(...bodyIndexes) : 0;
//   if (variableCount > 0) {
//     const samples = rawSamples.map((value) => String(value || "").trim());
//     if (samples.length < variableCount || samples.slice(0, variableCount).some((value) => !value)) {
//       throw ApiError.badRequest(`{{1}} se {{${variableCount}}} ke liye ${variableCount} sample value(s) deni hongi.`);
//     }
//     bodyComponent.example = { body_text: [samples.slice(0, variableCount)] };
//   }
//   components.push(bodyComponent);
//   if (footerText) components.push({ type: "FOOTER", text: footerText });

//   try {
//     const response = await axios.post(
//       `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/message_templates`,
//       { name, language, category, components },
//       { headers: { Authorization: `Bearer ${env.metaWhatsapp.accessToken}`, "Content-Type": "application/json" }, timeout: 20000 },
//     );
//     const created = response.data || {};
//     await WhatsAppTemplateAsset.findOneAndUpdate(
//       { ownerId: req.user.id, name, language },
//       { $set: { imageUrl: headerImageUrl, bodyText, } },
//       { upsert: true, new: true, setDefaultsOnInsert: true },
//     );
//     return new ApiResponse(201, {
//       template: { id: created.id || null, name, language, category, status: created.status || "PENDING", components, imageUrl: headerImageUrl, bodyText },
//       meta: created,
//     }, "Template Meta ko approval ke liye submit ho gaya. Approval status kuch samay baad refresh karein.").send(res);
//   } catch (err) {
//     const metaError = err.response?.data?.error;
//     logger.warn("[whatsapp] Template creation failed", { name, category, error: metaError || err.message });
//     throw new ApiError(err.response?.status && err.response.status < 500 ? 400 : 502, metaError?.error_user_msg || metaError?.message || "Meta template submit nahi ho paya. Permissions aur template fields check karein.", metaError || null);
//   }
// });

// module.exports = {
//   verifyWebhook,
//   receiveWebhook,
//   receiveForwardedWebhook,
//   sendTest,
//   sendTestTemplate,
//   getStatus,
//   diagnostics,
//   disconnect,
//   reconnect,
//   listApprovedTemplates,
//   listAllTemplates,
//   createTemplate,
//   deleteTemplate,
// };

const asyncHandler = require("../utils/asyncHandler");
const WhatsAppTemplateAsset = require("../models/WhatsAppTemplateAsset");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const env = require("../config/env");
const metaWhatsappClient = require("../services/whatsapp/metaWhatsappClient");
const { handleWebhook } = require("../services/whatsapp/webhookHandler");
const settingsService = require("../services/settings/settingsService");
const logger = require("../utils/logger");
const axios = require("axios");

/**
 * GET /api/whatsapp/webhook
 * One-time handshake Meta performs when you register/verify the webhook URL
 * in the Meta App Dashboard (WhatsApp -> Configuration -> Webhook).
 *
 * Meta sends:
 * hub.mode=subscribe
 * hub.verify_token=<the token entered in Meta Dashboard>
 * hub.challenge=<random string>
 *
 * If the token matches, echo hub.challenge back as plain text.
 */

const verifyWebhook = asyncHandler(async (req, res) => {
  // Parse query parameters directly from the request URL.
  // This avoids relying on Express's req.query parser.
  const queryString = (req.originalUrl || req.url).split("?")[1] || "";
  const params = new URLSearchParams(queryString);

  const mode = params.get("hub.mode")?.trim();
  const token = params.get("hub.verify_token")?.trim();
  const challenge = params.get("hub.challenge")?.trim();

  const configuredToken = env.metaWhatsapp.verifyToken;

  if (
    mode === "subscribe" &&
    configuredToken &&
    token === configuredToken &&
    challenge
  ) {
    logger.info("[whatsapp] Webhook verification succeeded");

    return res.status(200).type("text/plain").send(challenge);
  }

  // Do not log the actual verify token.
  logger.warn("[whatsapp] Webhook verification failed", {
    modeReceived: mode || null,
    tokenReceived: Boolean(token),
    tokenConfigured: Boolean(configuredToken),
    challengeReceived: Boolean(challenge),
    requestUrlHasQuery: queryString.length > 0,
  });

  return res.sendStatus(403);
});

// const verifyWebhook = asyncHandler(async (req, res) => {
//   // Express may return an array when query parameters are repeated.
//   const getQueryValue = (value) => {
//     const normalizedValue = Array.isArray(value) ? value[0] : value;

//     return typeof normalizedValue === "string"
//       ? normalizedValue.trim()
//       : normalizedValue;
//   };

//   const mode = getQueryValue(req.query["hub.mode"]);
//   const token = getQueryValue(req.query["hub.verify_token"]);
//   const challenge = getQueryValue(req.query["hub.challenge"]);

//   const configuredToken = env.metaWhatsapp.verifyToken;

//   if (
//     mode === "subscribe" &&
//     configuredToken &&
//     token === configuredToken &&
//     challenge
//   ) {
//     logger.info("[whatsapp] Webhook verification succeeded");
//     return res.status(200).type("text/plain").send(challenge);
//   }

//   // Never log the actual verify token.
//   logger.warn("[whatsapp] Webhook verification failed", {
//     modeReceived: mode,
//     tokenReceived: Boolean(token),
//     tokenConfigured: Boolean(configuredToken),
//     challengeReceived: Boolean(challenge),
//     tokenType: Array.isArray(req.query["hub.verify_token"])
//       ? "array"
//       : typeof req.query["hub.verify_token"],
//   });

//   return res.sendStatus(403);
// });

/**
 * POST /api/whatsapp/webhook
 * Public endpoint (no auth) — this is the URL you register in the Meta App
 * Dashboard under WhatsApp -> Configuration -> Webhook, subscribed to the
 * "messages" field.
 *
 * Always responds 200 quickly; Meta retries on anything else.
 */
const receiveWebhook = asyncHandler(async (req, res) => {
  logger.info(`[whatsapp] Webhook hit: object=${req.body?.object}`);

  // Respond immediately. AI processing may take longer than Meta's
  // expected webhook response time.
  res.status(200).json({ ok: true });

  handleWebhook(req.body).catch((err) =>
    logger.error("[whatsapp] Unhandled webhook processing error", {
      error: err.message,
    }),
  );
});

/**
 * POST /api/whatsapp/webhook/forward
 *
 * Optional bridge for deployments where the SAME Meta App webhook is already
 * owned by n8n. n8n can forward the raw Meta JSON to this endpoint with
 * X-PropAI-Webhook-Secret.
 *
 * This endpoint intentionally does not require a user JWT because it is
 * machine-to-machine. Keep the secret private.
 */
const receiveForwardedWebhook = asyncHandler(async (req, res) => {
  if (!env.metaWhatsapp.forwardSecret) {
    return res.sendStatus(404);
  }

  const supplied = req.get("X-PropAI-Webhook-Secret");

  if (!supplied || supplied !== env.metaWhatsapp.forwardSecret) {
    return res.sendStatus(401);
  }

  logger.info(`[whatsapp] Forwarded webhook hit: object=${req.body?.object}`);

  res.status(200).json({ ok: true });

  handleWebhook(req.body).catch((err) =>
    logger.error("[whatsapp] Unhandled forwarded webhook processing error", {
      error: err.message,
    }),
  );
});

/**
 * POST /api/whatsapp/send-test
 *
 * Manual/dev utility to confirm the Meta WhatsApp Cloud API integration can
 * actually send.
 *
 * Like every free-text send, this only works within 24h of the target number
 * having messaged your WhatsApp number at least once.
 *
 * Use send-test-template below to reach a brand-new number.
 */
const sendTest = asyncHandler(async (req, res) => {
  const { phone, text } = req.body;

  if (!phone || !text) {
    throw ApiError.badRequest("phone and text are required");
  }

  const settings = await settingsService.getOrCreateSettings();

  if (settings.whatsappDisconnected) {
    throw ApiError.badRequest(
      "WhatsApp is disconnected for your account — reconnect it from Settings first",
    );
  }

  const { messageId } = await metaWhatsappClient.sendTextMessage({
    phone,
    text,
  });

  return new ApiResponse(200, { messageId }, "Message sent").send(res);
});

/**
 * POST /api/whatsapp/send-test-template
 *
 * Dev utility to send the configured opening TEMPLATE to any number,
 * bypassing the 24h window rule.
 *
 * Useful to confirm the approved template works before wiring it into the
 * real lead-creation flow.
 */
const sendTestTemplate = asyncHandler(async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    throw ApiError.badRequest("phone is required");
  }

  const settings = await settingsService.getOrCreateSettings();

  const templateName =
    settings.openingTemplate?.name || env.metaWhatsapp.openingTemplateName;

  const templateLanguage =
    settings.openingTemplate?.language ||
    env.metaWhatsapp.openingTemplateLanguage;

  if (!templateName) {
    throw ApiError.badRequest(
      "No approved WhatsApp opening template is configured",
    );
  }

  const { messageId } = await metaWhatsappClient.sendTemplateMessage({
    phone,
    templateName,
    languageCode: templateLanguage,
  });

  return new ApiResponse(200, { messageId }, "Template message sent").send(res);
});

/**
 * GET /api/whatsapp/diagnostics
 *
 * Verifies the configured sender and WABA mapping.
 */
const diagnostics = asyncHandler(async (req, res) => {
  const configured = Boolean(
    env.metaWhatsapp.accessToken &&
    env.metaWhatsapp.phoneNumberId &&
    env.metaWhatsapp.businessAccountId,
  );

  if (!configured) {
    throw ApiError.badRequest("Meta WhatsApp credentials are incomplete");
  }

  try {
    const result = await metaWhatsappClient.verifyConfiguration();

    return new ApiResponse(
      200,
      {
        provider: "meta_cloud_api",
        apiVersion: env.metaWhatsapp.apiVersion,
        phoneNumberId: env.metaWhatsapp.phoneNumberId,
        businessAccountId: env.metaWhatsapp.businessAccountId,
        phoneNumberBelongsToWaba: result.phoneNumberBelongsToWaba,
        sender: result.account,
        wabaPhoneNumbers: result.wabaPhoneNumbers,
      },
      "Meta WhatsApp configuration verified",
    ).send(res);
  } catch (err) {
    return new ApiResponse(
      502,
      {
        provider: "meta_cloud_api",
        phoneNumberId: env.metaWhatsapp.phoneNumberId,
        businessAccountId: env.metaWhatsapp.businessAccountId,
        ok: false,
        metaError: err.metaError ||
          err.response?.data?.error || {
            message: err.message,
            code: err.code,
          },
      },
      "Meta WhatsApp configuration verification failed",
    ).send(res);
  }
});

/**
 * GET /api/whatsapp/status
 *
 * Reports whether Meta WhatsApp Cloud API is configured, the connected
 * number (best-effort, straight from Meta), and whether this org has hit
 * "Disconnect" on the Settings page.
 */
const getStatus = asyncHandler(async (req, res) => {
  const configured = Boolean(
    env.metaWhatsapp.accessToken && env.metaWhatsapp.phoneNumberId,
  );

  const settings = await settingsService.getOrCreateSettings();

  let phoneNumber = null;
  let verifiedName = null;
  let liveStatus = null;
  let qualityRating = null;

  if (configured) {
    try {
      const info = await metaWhatsappClient.getAccountInfo();

      phoneNumber = info.phoneNumber;
      verifiedName = info.verifiedName;
      liveStatus = info.status;
      qualityRating = info.qualityRating;
    } catch (err) {
      logger.warn(
        "[whatsapp] Could not fetch Meta account info for status page",
        {
          error: err.response?.data || err.message,
        },
      );
    }
  }

  return new ApiResponse(200, {
    provider: "meta_cloud_api",
    configured,
    phoneNumberId: configured ? env.metaWhatsapp.phoneNumberId : null,
    businessAccountId: env.metaWhatsapp.businessAccountId,
    apiVersion: env.metaWhatsapp.apiVersion,
    phoneNumber,
    verifiedName,
    liveStatus,
    qualityRating,
    openingTemplateConfigured: Boolean(
      settings.openingTemplate?.name || env.metaWhatsapp.openingTemplateName,
    ),
    openingTemplateName:
      settings.openingTemplate?.name ||
      env.metaWhatsapp.openingTemplateName ||
      null,
    openingTemplateLanguage:
      settings.openingTemplate?.language ||
      env.metaWhatsapp.openingTemplateLanguage,
    disconnected: settings.whatsappDisconnected,
  }).send(res);
});

/**
 * POST /api/whatsapp/disconnect
 *
 * Stops AI auto-replies and manual/test sends for this org.
 * Does NOT touch the underlying Meta WhatsApp number.
 */
const disconnect = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings({
    whatsappDisconnected: true,
  });

  return new ApiResponse(200, { settings }, "WhatsApp disconnected").send(res);
});

/**
 * POST /api/whatsapp/reconnect
 */
const reconnect = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings({
    whatsappDisconnected: false,
  });

  return new ApiResponse(200, { settings }, "WhatsApp reconnected").send(res);
});

async function fetchMetaTemplates() {
  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.businessAccountId) {
    throw ApiError.badRequest(
      "Meta WhatsApp access token aur Business Account ID configure karein.",
    );
  }
  const all = [];
  let url = `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/message_templates`;
  let params = {
    fields: "name,language,status,category,components,rejected_reason",
    limit: 100,
  };
  // A few bounded pages are enough for this client's template catalogue and avoid an unbounded API loop.
  for (let page = 0; url && page < 5; page += 1) {
    const response = await axios.get(url, {
      params,
      headers: { Authorization: `Bearer ${env.metaWhatsapp.accessToken}` },
      timeout: 15000,
    });
    all.push(...(response.data?.data || []));
    url = response.data?.paging?.next || null;
    params = undefined;
  }
  return all.map((item) => ({
    id: item.id || null,
    name: item.name,
    language: item.language,
    category: item.category || "",
    status: item.status || "UNKNOWN",
    rejectedReason:
      item.rejected_reason && item.rejected_reason !== "NONE"
        ? item.rejected_reason
        : "",
    components: item.components || [],
  }));
}

async function addTemplateAssets(templates, ownerId) {
  const assets = await WhatsAppTemplateAsset.find({ ownerId }).lean();
  const byKey = new Map(
    assets.map((asset) => [`${asset.name}::${asset.language}`, asset]),
  );
  return templates.map((template) => {
    const asset = byKey.get(`${template.name}::${template.language}`);
    return {
      ...template,
      imageUrl: asset?.imageUrl || "",
      bodyText:
        asset?.bodyText ||
        (template.components || []).find(
          (part) => String(part.type).toUpperCase() === "BODY",
        )?.text ||
        "",
    };
  });
}

async function uploadTemplateImageToMeta(imageUrl) {
  if (!env.metaWhatsapp.appId)
    throw ApiError.badRequest(
      "Image-header Meta templates ke liye backend META_APP_ID bhi configure karein. Cloudinary upload URL ko Meta template sample ke roop mein submit karne ke liye App ID zaroori hai.",
    );
  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    throw ApiError.badRequest(
      "Header image must be a valid HTTPS Cloudinary URL.",
    );
  }
  if (
    parsedUrl.protocol !== "https:" ||
    !["res.cloudinary.com", "cloudinary.com"].includes(
      parsedUrl.hostname.toLowerCase(),
    )
  ) {
    throw ApiError.badRequest(
      "WhatsApp template header image should be uploaded to this app first (Cloudinary HTTPS URL required).",
    );
  }
  const imageResponse = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: 20000,
    maxContentLength: 8 * 1024 * 1024,
  });
  const buffer = Buffer.from(imageResponse.data);
  const mime = String(
    imageResponse.headers["content-type"] || "image/jpeg",
  ).split(";")[0];
  if (!mime.startsWith("image/"))
    throw ApiError.badRequest("Template header URL par valid image nahi mili.");
  if (buffer.length > 5 * 1024 * 1024)
    throw ApiError.badRequest(
      "Meta template header example image 5 MB se chhoti honi chahiye.",
    );
  const init = await axios.post(
    `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.appId}/uploads`,
    null,
    {
      params: {
        file_length: buffer.length,
        file_type: mime,
        access_token: env.metaWhatsapp.accessToken,
      },
      timeout: 20000,
    },
  );
  const sessionId = init.data?.id;
  if (!sessionId)
    throw ApiError.badRequest(
      "Meta image upload session create nahi hui. META_APP_ID aur token permissions check karein.",
    );
  const uploaded = await axios.post(
    `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${sessionId}`,
    buffer,
    {
      headers: {
        Authorization: `OAuth ${env.metaWhatsapp.accessToken}`,
        "Content-Type": "application/octet-stream",
        file_offset: "0",
      },
      timeout: 30000,
      maxBodyLength: 8 * 1024 * 1024,
    },
  );
  const handle = uploaded.data?.h;
  if (!handle) throw ApiError.badRequest("Meta se image handle nahi mila.");
  return handle;
}

/** DELETE /api/whatsapp/templates/:name — delete a Meta template by name. */
const deleteTemplate = asyncHandler(async (req, res) => {
  const name = String(req.params?.name || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name)) {
    throw ApiError.badRequest("Invalid template name.");
  }
  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.businessAccountId) {
    throw ApiError.badRequest(
      "Meta WhatsApp access token aur Business Account ID configure karein.",
    );
  }

  try {
    await axios.delete(
      `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/message_templates`,
      {
        params: { name },
        headers: { Authorization: `Bearer ${env.metaWhatsapp.accessToken}` },
        timeout: 15000,
      },
    );
    await WhatsAppTemplateAsset.deleteMany({ ownerId: req.user.id, name });
    return new ApiResponse(
      200,
      { deleted: true, name },
      "WhatsApp template deleted from Meta",
    ).send(res);
  } catch (err) {
    const metaError = err.response?.data?.error;
    logger.warn("[whatsapp] Template delete failed", {
      name,
      error: metaError || err.message,
    });
    throw new ApiError(
      err.response?.status && err.response.status < 500 ? 400 : 502,
      metaError?.error_user_msg ||
        metaError?.message ||
        "Meta template delete nahi ho paya. Permissions aur template name check karein.",
      metaError || null,
    );
  }
});

/** GET /api/whatsapp/templates — approved templates only, used by the sender. */
const listApprovedTemplates = asyncHandler(async (req, res) => {
  try {
    const templates = await addTemplateAssets(
      (await fetchMetaTemplates()).filter(
        (item) => String(item.status).toUpperCase() === "APPROVED",
      ),
      req.user.id,
    );
    return new ApiResponse(
      200,
      { templates, configured: true },
      "Approved templates loaded",
    ).send(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const metaError = err.response?.data?.error;
    logger.error("[whatsapp] Could not list approved templates", {
      error: metaError || err.message,
    });
    throw new ApiError(
      502,
      metaError?.message ||
        "Meta templates could not be loaded. Check WhatsApp permissions and WABA ID.",
    );
  }
});

/** GET /api/whatsapp/templates/all — status catalogue for the Template Manager. */
const listAllTemplates = asyncHandler(async (req, res) => {
  try {
    const templates = await addTemplateAssets(
      await fetchMetaTemplates(),
      req.user.id,
    );
    return new ApiResponse(
      200,
      { templates, configured: true },
      "WhatsApp templates loaded",
    ).send(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const metaError = err.response?.data?.error;
    logger.error("[whatsapp] Could not load template catalogue", {
      error: metaError || err.message,
    });
    throw new ApiError(
      502,
      metaError?.message ||
        "Meta templates could not be loaded. Check whatsapp_business_management permission and WABA ID.",
    );
  }
});

/** POST /api/whatsapp/templates — create a template in Meta and submit it for review. */
const createTemplate = asyncHandler(async (req, res) => {
  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.businessAccountId) {
    throw ApiError.badRequest(
      "Meta WhatsApp access token aur Business Account ID configure karein.",
    );
  }
  const name = String(req.body?.name || "")
    .trim()
    .toLowerCase();
  const category = String(req.body?.category || "MARKETING")
    .trim()
    .toUpperCase();
  const language = String(req.body?.language || "en_US").trim();
  const bodyText = String(req.body?.bodyText || "").trim();
  const headerText = String(req.body?.headerText || "").trim();
  const headerImageUrl = String(req.body?.headerImageUrl || "").trim();
  const footerText = String(req.body?.footerText || "").trim();
  const rawSamples = Array.isArray(req.body?.sampleValues)
    ? req.body.sampleValues
    : [];
  const rawButtons = Array.isArray(req.body?.buttons) ? req.body.buttons : [];
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name) || name.length > 512) {
    throw ApiError.badRequest(
      "Template name mein sirf lowercase letters, numbers aur single underscores use karein (e.g. property_offer_2026).",
    );
  }
  if (!["MARKETING", "UTILITY"].includes(category))
    throw ApiError.badRequest(
      "Is builder mein category MARKETING ya UTILITY honi chahiye.",
    );
  if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(language))
    throw ApiError.badRequest("Language code e.g. en_US ya hi_IN use karein.");
  if (!bodyText || bodyText.length > 1024)
    throw ApiError.badRequest(
      "Body required hai aur 1,024 characters se zyada nahi ho sakta.",
    );
  if (headerText.length > 60 || footerText.length > 60)
    throw ApiError.badRequest(
      "Header/footer maximum 60 characters ke ho sakte hain.",
    );
  if (rawButtons.length > 3)
    throw ApiError.badRequest("Maximum 3 template buttons allowed hain.");
  const bodyIndexes = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((match) =>
    Number(match[1]),
  );
  if (bodyIndexes.some((value) => value < 1)) {
    throw ApiError.badRequest(
      "Template variables {{1}}, {{2}} jaise format mein honi chahiye.",
    );
  }
  const uniqueIndexes = [...new Set(bodyIndexes)].sort((a, b) => a - b);
  if (uniqueIndexes.some((value, index) => value !== index + 1)) {
    throw ApiError.badRequest(
      "Template variables sequential honi chahiye: {{1}}, {{2}}, {{3}} without gaps.",
    );
  }
  const components = [];
  if (headerImageUrl) {
    if (!/^https:\/\//i.test(headerImageUrl))
      throw ApiError.badRequest("Header image URL must use HTTPS.");
    const headerHandle = await uploadTemplateImageToMeta(headerImageUrl);
    components.push({
      type: "HEADER",
      format: "IMAGE",
      example: { header_handle: [headerHandle] },
    });
  } else if (headerText) {
    components.push({ type: "HEADER", format: "TEXT", text: headerText });
  }
  const bodyComponent = { type: "BODY", text: bodyText };
  const variableCount = bodyIndexes.length ? Math.max(...bodyIndexes) : 0;
  if (variableCount > 0) {
    const samples = rawSamples.map((value) => String(value || "").trim());
    if (
      samples.length < variableCount ||
      samples.slice(0, variableCount).some((value) => !value)
    ) {
      throw ApiError.badRequest(
        `{{1}} se {{${variableCount}}} ke liye ${variableCount} sample value(s) deni hongi.`,
      );
    }
    bodyComponent.example = { body_text: [samples.slice(0, variableCount)] };
  }
  components.push(bodyComponent);
  if (footerText) components.push({ type: "FOOTER", text: footerText });
  if (rawButtons.length) {
    const buttons = rawButtons.map((button) => {
      const type = String(button?.type || "QUICK_REPLY").toUpperCase();
      const text = String(button?.text || "").trim();
      if (!text || text.length > 25)
        throw ApiError.badRequest(
          "Button text required hai aur 25 characters se zyada nahi ho sakta.",
        );
      if (type === "QUICK_REPLY") return { type, text };
      if (type === "URL") {
        const url = String(button?.url || "").trim();
        if (!/^https:\/\//i.test(url))
          throw ApiError.badRequest(
            "Website button ke liye valid HTTPS URL required hai.",
          );
        return { type, text, url };
      }
      if (type === "PHONE_NUMBER") {
        const phone_number = String(button?.phone_number || "").trim();
        if (!/^\+[1-9]\d{7,14}$/.test(phone_number))
          throw ApiError.badRequest(
            "Phone button number country code ke saath E.164 format mein hona chahiye.",
          );
        return { type, text, phone_number };
      }
      throw ApiError.badRequest(
        "Unsupported button type. URL, PHONE_NUMBER ya QUICK_REPLY use karein.",
      );
    });
    components.push({ type: "BUTTONS", buttons });
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/message_templates`,
      { name, language, category, components },
      {
        headers: {
          Authorization: `Bearer ${env.metaWhatsapp.accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      },
    );
    const created = response.data || {};
    await WhatsAppTemplateAsset.findOneAndUpdate(
      { ownerId: req.user.id, name, language },
      { $set: { imageUrl: headerImageUrl, bodyText } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return new ApiResponse(
      201,
      {
        template: {
          id: created.id || null,
          name,
          language,
          category,
          status: created.status || "PENDING",
          components,
          imageUrl: headerImageUrl,
          bodyText,
        },
        meta: created,
      },
      "Template Meta ko approval ke liye submit ho gaya. Approval status kuch samay baad refresh karein.",
    ).send(res);
  } catch (err) {
    const metaError = err.response?.data?.error;
    logger.warn("[whatsapp] Template creation failed", {
      name,
      category,
      error: metaError || err.message,
    });
    throw new ApiError(
      err.response?.status && err.response.status < 500 ? 400 : 502,
      metaError?.error_user_msg ||
        metaError?.message ||
        "Meta template submit nahi ho paya. Permissions aur template fields check karein.",
      metaError || null,
    );
  }
});

module.exports = {
  verifyWebhook,
  receiveWebhook,
  receiveForwardedWebhook,
  sendTest,
  sendTestTemplate,
  getStatus,
  diagnostics,
  disconnect,
  reconnect,
  listApprovedTemplates,
  listAllTemplates,
  createTemplate,
  deleteTemplate,
};
