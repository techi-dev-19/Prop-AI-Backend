const rateLimit = require('express-rate-limit');
const env = require('../config/env');

// General API limiter - applied globally in app.js
const apiLimiter = rateLimit({
  windowMs: env.rateLimit.windowMin * 60 * 1000,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
  // Meta can retry/batch webhook deliveries independently of browser traffic.
  // Do not let the normal API limiter cause webhook 429s.
  skip: (req) => req.path === '/api/whatsapp/webhook' || req.path.startsWith('/api/whatsapp/webhook/'),
});

// Tighter limiter for auth routes (login/register/forgot-password) to slow
// down credential-stuffing / brute-force attempts.
const authLimiter = rateLimit({
  windowMs: env.rateLimit.windowMin * 60 * 1000,
  max: env.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts, please try again later.' },
});

module.exports = { apiLimiter, authLimiter };
