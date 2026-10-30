const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Notification = require('../models/Notification');

/** GET /api/notifications — paginated list, newest first, optional ?unread=true */
const listNotifications = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, unread } = req.query;
  const filter = { userId: req.user.id };
  if (unread === 'true') filter.isRead = false;

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit)),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId: req.user.id, isRead: false }),
  ]);

  return new ApiResponse(200, {
    items,
    unreadCount,
    pagination: { page: Number(page), limit: Number(limit), total },
  }, 'Notifications fetched').send(res);
});

/** PATCH /api/notifications/:id/read — mark a single notification as read. */
const markAsRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { isRead: true },
    { new: true }
  );
  if (!notification) throw ApiError.notFound('Notification not found');
  return new ApiResponse(200, notification, 'Notification marked as read').send(res);
});

/** PATCH /api/notifications/read-all — mark every unread notification as read. */
const markAllAsRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ userId: req.user.id, isRead: false }, { isRead: true });
  return new ApiResponse(200, null, 'All notifications marked as read').send(res);
});

/** DELETE /api/notifications/:id */
const deleteNotification = asyncHandler(async (req, res) => {
  const notification = await Notification.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!notification) throw ApiError.notFound('Notification not found');
  return new ApiResponse(200, null, 'Notification deleted').send(res);
});

/**
 * Internal helper (not an HTTP handler) — used by other services (lead scoring,
 * follow-up generation, whatsapp inbound handler, etc.) to create notifications
 * without duplicating the shape everywhere.
 */
const createNotification = async ({ userId, type, title, body = '', link = null }) => {
  return Notification.create({ userId, type, title, body, link });
};

module.exports = {
  listNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  createNotification,
};
