const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Verifies the `X-Hub-Signature-256` header Meta sends on every WhatsApp
 * webhook POST, proving the request actually came from Meta and not some
 * random internet POST guessing your webhook URL.
 *
 * Optional by design: if META_WHATSAPP_APP_SECRET isn't set, this just
 * passes every request through unchecked (useful while you're still setting
 * things up) — set it in production. Get the App Secret from the Meta App
 * Dashboard -> Settings -> Basic -> App Secret.
 */
function verifyMetaSignature(req, res, next) {
  if (!env.metaWhatsapp.appSecret) return next(); // not configured — skip check

  const signatureHeader = req.get('X-Hub-Signature-256'); // "sha256=<hex>"
  if (!signatureHeader || !req.rawBody) {
    logger.warn('[whatsapp] Webhook POST missing signature header or raw body — rejecting');
    return res.sendStatus(401);
  }

  const expected =
    'sha256=' + crypto.createHmac('sha256', env.metaWhatsapp.appSecret).update(req.rawBody).digest('hex');

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) {
    logger.warn('[whatsapp] Webhook POST signature mismatch — rejecting');
    return res.sendStatus(401);
  }

  return next();
}

module.exports = verifyMetaSignature;
