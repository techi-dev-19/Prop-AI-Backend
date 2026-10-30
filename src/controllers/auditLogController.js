const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const AuditLog = require('../models/AuditLog');

/** GET /api/audit-logs — admin-only, paginated, filterable by userId/action/date range. */
const listAuditLogs = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, userId, action, from, to } = req.query;

  const filter = {};
  if (userId) filter.userId = userId;
  if (action) filter.action = action;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate('userId', 'name email role'),
    AuditLog.countDocuments(filter),
  ]);

  return new ApiResponse(200, {
    items,
    pagination: { page: Number(page), limit: Number(limit), total },
  }, 'Audit logs fetched').send(res);
});

/**
 * Internal helper (not an HTTP handler) — call from anywhere in the app to
 * record an action. Never throws; a logging failure must not break the
 * primary request.
 */
const recordAuditLog = async ({ userId = null, action, entityType = null, entityId = null, meta = {}, ip = null }) => {
  try {
    await AuditLog.create({ userId, action, entityType, entityId, meta, ip });
  } catch (err) {
    // Intentionally swallowed — audit logging is best-effort.
  }
};

module.exports = { listAuditLogs, recordAuditLog };
