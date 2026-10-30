const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  generateRawToken,
} = require('../utils/tokens');
const { sendPasswordResetEmail } = require('../services/email/mailer');

const REFRESH_COOKIE_NAME = 'refreshToken';

function durationToMs(value, fallback = 90 * 24 * 60 * 60 * 1000) {
  const match = String(value || '').match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * multipliers[match[2].toLowerCase()];
}

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite || 'lax',
    domain: env.cookie.domain,
    path: '/api/auth', // only sent back to auth endpoints
    maxAge: durationToMs(env.jwt.refreshExpiresIn),
  };
}

async function issueTokens(res, user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  user.refreshTokenHash = hashToken(refreshToken);
  await user.save();

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return accessToken;
}

/**
 * POST /api/auth/login
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (env.clientEmail && normalizedEmail !== env.clientEmail) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');
  if (!user || !(await user.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!user.isActive) {
    throw ApiError.forbidden('This account has been deactivated');
  }

  const accessToken = await issueTokens(res, user);

  user.lastLoginAt = new Date();
  await user.save();

  await AuditLog.create({
    userId: user._id,
    action: 'auth.login',
    entityType: 'User',
    entityId: user._id,
    ip: req.ip,
  });

  return new ApiResponse(
    200,
    { user: user.toSafeJSON(), accessToken },
    'Logged in successfully'
  ).send(res);
});

/**
 * POST /api/auth/refresh
 * Rotates the refresh token on every use (reuse detection: if the incoming
 * token doesn't match the stored hash, every session for that user is killed).
 */
const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) throw ApiError.unauthorized('Missing refresh token');

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  const user = await User.findById(payload.sub).select('+refreshTokenHash');
  if (!user || !user.isActive || (env.clientEmail && String(user.email || '').toLowerCase() !== env.clientEmail)) {
    throw ApiError.unauthorized('Account not found or deactivated');
  }

  const incomingHash = hashToken(token);
  if (!user.refreshTokenHash || user.refreshTokenHash !== incomingHash) {
    // Possible token reuse/theft: invalidate all sessions for this user.
    user.tokenVersion += 1;
    user.refreshTokenHash = null;
    await user.save();
    throw ApiError.unauthorized('Refresh token invalid — please log in again');
  }

  const accessToken = await issueTokens(res, user); // rotates refresh token too

  return new ApiResponse(200, { accessToken }, 'Token refreshed').send(res);
});

/**
 * POST /api/auth/logout
 */
const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (token) {
    try {
      const payload = verifyRefreshToken(token);
      await User.findByIdAndUpdate(payload.sub, { refreshTokenHash: null });
    } catch {
      // token already invalid/expired - nothing to clean up
    }
  }
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
  return new ApiResponse(200, null, 'Logged out').send(res);
});

/**
 * POST /api/auth/forgot-password
 * Always returns a generic success message, whether or not the email exists,
 * to avoid leaking which addresses are registered.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = env.clientEmail && email !== env.clientEmail ? null : await User.findOne({ email });

  if (user) {
    const rawToken = generateRawToken();
    user.resetPasswordTokenHash = hashToken(rawToken);
    user.resetPasswordExpires = new Date(Date.now() + env.resetTokenExpiresMin * 60 * 1000);
    await user.save();

    const resetLink = `${env.appBaseUrl}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail(user.email, resetLink).catch((err) => {
      // Log but don't fail the request just because email delivery had an issue.
      req.app.get('logger')?.error?.('Failed to send reset email', err);
    });
  }

  return new ApiResponse(
    200,
    null,
    'If an account with that email exists, a reset link has been sent.'
  ).send(res);
});

/**
 * POST /api/auth/reset-password
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const tokenHash = hashToken(token);

  const user = await User.findOne({
    ...(env.clientEmail ? { email: env.clientEmail } : {}),
    resetPasswordTokenHash: tokenHash,
    resetPasswordExpires: { $gt: new Date() },
  }).select('+resetPasswordTokenHash +resetPasswordExpires');

  if (!user) {
    throw ApiError.badRequest('Reset link is invalid or has expired');
  }

  user.setPassword(password);
  user.resetPasswordTokenHash = null;
  user.resetPasswordExpires = null;
  user.tokenVersion += 1; // invalidate any existing sessions
  user.refreshTokenHash = null;
  await user.save();

  return new ApiResponse(200, null, 'Password reset successfully. Please log in.').send(res);
});

/**
 * GET /api/auth/me
 */
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) throw ApiError.notFound('User not found');
  return new ApiResponse(200, { user: user.toSafeJSON() }).send(res);
});

/**
 * PATCH /api/auth/profile
 * Updates the logged-in user's own name/email/phone (used by the Profile
 * page). Email changes are checked for uniqueness against other accounts.
 */
const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, phone } = req.body;

  const user = await User.findById(req.user.id);
  if (!user) throw ApiError.notFound('User not found');

  if (email && env.clientEmail && email.toLowerCase() !== env.clientEmail) {
    throw ApiError.badRequest('Login email is locked for this single-client deployment. Update CLIENT_EMAIL on the backend and reseed/reconcile the account to change it.');
  }

  if (email && email.toLowerCase() !== user.email) {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing && existing._id.toString() !== user._id.toString()) {
      throw ApiError.conflict('That email is already in use by another account');
    }
    user.email = email.toLowerCase();
  }

  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone;

  await user.save();

  await AuditLog.create({
    userId: user._id,
    action: 'auth.updateProfile',
    entityType: 'User',
    entityId: user._id,
    ip: req.ip,
  });

  return new ApiResponse(200, { user: user.toSafeJSON() }, 'Profile updated').send(res);
});

module.exports = {
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  getMe,
  updateProfile,
};
