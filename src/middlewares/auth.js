const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../utils/tokens');
const User = require('../models/User');

/**
 * Requires a valid access token in the Authorization header:
 *   Authorization: Bearer <token>
 * Populates req.user with { id, role } from the token,
 * then confirms the account still exists and is active.
 */
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw ApiError.unauthorized('Missing or malformed access token');
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      throw ApiError.unauthorized(
        err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token'
      );
    }

    const user = await User.findById(payload.sub);
    const allowedClientEmail = String(process.env.CLIENT_EMAIL || '').trim().toLowerCase();
    if (!user || !user.isActive || (allowedClientEmail && String(user.email || '').toLowerCase() !== allowedClientEmail)) {
      throw ApiError.unauthorized('Account not found, deactivated, or not enabled for this single-client deployment');
    }

    // Always re-derive role from the DB record, never trust the token alone
    // for authorization decisions beyond identity.
    req.user = {
      id: user._id.toString(),
      role: user.role,
      email: user.email,
      name: user.name,
    };

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = authenticate;
