const ApiError = require('../utils/ApiError');

/**
 * Restricts a route to specific roles. Must run after `authenticate`.
 * Usage: router.get('/admin-only', authenticate, roleGuard('admin'), handler)
 */
const roleGuard = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return next(ApiError.unauthorized('Authentication required'));
  }
  if (!allowedRoles.includes(req.user.role)) {
    return next(ApiError.forbidden('You do not have permission to perform this action'));
  }
  next();
};

module.exports = roleGuard;
