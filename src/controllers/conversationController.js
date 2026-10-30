const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const LeadScore = require('../models/LeadScore');
const FollowUp = require('../models/FollowUp');
const Meeting = require('../models/Meeting');
const metaWhatsappClient = require('../services/whatsapp/metaWhatsappClient');
const { recordOutboundMessage } = require('../services/whatsapp/messageStore');
const { emitToUser } = require('../sockets');

/** Brokers see only their own conversations; admins may pass ?ownerId= to inspect a specific broker. */
function scopeOwnerId(req) {
  if (req.user.role === 'admin' && req.query.ownerId) return req.query.ownerId;
  return req.user.id;
}

/**
 * GET /api/conversations
 * Supports the left-hand filter rail from the spec: unread, hot, warm, cold,
 * site_visit, closed, lost — plus free-text search on the lead's name/phone.
 */
const listConversations = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { filter, search, page, limit, leadId } = req.query;

  const leadFilter = { ownerId };
  if (leadId) leadFilter._id = leadId; // open a lead's chat straight from Leads / Follow Ups
  if (['hot', 'warm', 'cold', 'closed', 'lost', 'site_visit'].includes(filter)) {
    leadFilter.status = filter;
  }
  if (search) {
    const escaped = String(search).trim().slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    leadFilter.$or = [
      { name: new RegExp(escaped, 'i') },
      { phone: new RegExp(escaped, 'i') },
    ];
  }

  const leadIds = await Lead.find(leadFilter).distinct('_id');

  // Imported contacts may have an empty Conversation shell for future sends.
  // Only show a thread after a real inbound message or a successfully sent outbound message exists.
  const activeConversationIds = await Message.distinct('conversationId', {
    $or: [
      { direction: 'inbound', sender: 'customer' },
      { direction: 'outbound', status: { $in: ['sent', 'delivered', 'read'] } },
    ],
  });
  const convFilter = { ownerId, leadId: { $in: leadIds }, _id: { $in: activeConversationIds } };
  if (filter === 'unread') convFilter.unreadCount = { $gt: 0 };

  const [conversations, total] = await Promise.all([
    Conversation.find(convFilter)
      .populate('leadId', 'name phone city status leadScore source')
      .populate('recommendedProperties', 'projectName city bhk')
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Conversation.countDocuments(convFilter),
  ]);

  return new ApiResponse(200, {
    conversations,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/**
 * GET /api/conversations/:id
 * Full thread for the right-hand panel: lead profile, AI summary, score,
 * recommended properties, meeting status, and paginated message history.
 */
const getConversation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { page = 1, limit = 50 } = req.query;

  const conversation = await Conversation.findOne({ _id: req.params.id, ownerId })
    .populate('leadId')
    .populate('recommendedProperties');
  if (!conversation) throw ApiError.notFound('Conversation not found');

  const [messages, messageCount] = await Promise.all([
    Message.find({ conversationId: conversation._id })
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean(),
    Message.countDocuments({ conversationId: conversation._id }),
  ]);
  messages.reverse(); // oldest -> newest for chat UI rendering

  // Right-hand "summary" panel: latest score reason, next follow-up, site visits.
  const leadObjectId = conversation.leadId?._id || conversation.leadId;
  const [latestScore, followUp, meetings] = await Promise.all([
    LeadScore.findOne({ leadId: leadObjectId }).sort({ createdAt: -1 }).lean(),
    FollowUp.findOne({ leadId: leadObjectId, status: 'pending' }).sort({ nextFollowUpDate: 1 }).lean(),
    Meeting.find({ leadId: leadObjectId, status: { $ne: 'cancelled' } })
      .populate('propertyId', 'projectName city')
      .sort({ preferredDate: -1, preferredTime: -1 })
      .limit(5)
      .lean(),
  ]);

  return new ApiResponse(200, {
    conversation,
    messages,
    insights: { latestScore, followUp, meetings },
    pagination: { page: Number(page), limit: Number(limit), total: messageCount },
  }).send(res);
});

/**
 * POST /api/conversations/:id/messages
 * Broker sends a message by hand. Does NOT change conversation.status —
 * a broker can drop into a live AI conversation for one message without
 * permanently taking it over (use /takeover for that).
 */
const sendManualReply = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { text } = req.body;

  const conversation = await Conversation.findOne({ _id: req.params.id, ownerId }).populate('leadId');
  if (!conversation) throw ApiError.notFound('Conversation not found');
  if (!conversation.leadId) throw ApiError.badRequest('This conversation has no associated lead');

  const settingsService = require('../services/settings/settingsService');
  const settings = await settingsService.getOrCreateSettings();
  if (settings.whatsappDisconnected) {
    throw ApiError.badRequest('WhatsApp is disconnected — reconnect it from Settings first');
  }

  // Free-text is only allowed while the WhatsApp 24h customer-service
  // window is open. That window starts from the lead's last inbound message,
  // not from our last outbound message.
  const lastInboundAt = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
  const within24Hours = lastInboundAt > 0 && (Date.now() - lastInboundAt) < 24 * 60 * 60 * 1000;

  if (!within24Hours) {
    throw ApiError.badRequest(
      'WHATSAPP_24H_WINDOW_CLOSED: The lead has not messaged this WhatsApp number within the last 24 hours. Send an approved WhatsApp template first.'
    );
  }

  const { messageId } = await metaWhatsappClient.sendTextMessage({
    phone: conversation.leadId.phone,
    text,
  });

  const message = await recordOutboundMessage({
    conversationId: conversation._id,
    leadId: conversation.leadId._id,
    text,
    sender: 'broker',
    whatsappMessageId: messageId || null,
  });

  emitToUser(ownerId, 'conversation:newMessage', { conversationId: conversation._id, leadId: conversation.leadId._id, message });

  return new ApiResponse(201, { message }, 'Message sent').send(res);
});

/**
 * POST /api/conversations/:id/takeover
 * "Take Over Chat" — pauses the AI for this one lead so only the broker replies.
 */
const takeOverChat = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: 'manual' } },
    { new: true }
  );
  if (!conversation) throw ApiError.notFound('Conversation not found');
  return new ApiResponse(200, { conversation }, 'AI paused for this conversation — you have taken over').send(res);
});

/**
 * POST /api/conversations/:id/resume-ai
 * "Resume AI" — hands the conversation back to the AI engine.
 */
const resumeAI = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: 'ai_active' } },
    { new: true }
  );
  if (!conversation) throw ApiError.notFound('Conversation not found');
  return new ApiResponse(200, { conversation }, 'AI resumed for this conversation').send(res);
});

/** POST /api/conversations/:id/read — clears the unread badge. */
const markRead = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { unreadCount: 0 } },
    { new: true }
  );
  if (!conversation) throw ApiError.notFound('Conversation not found');
  return new ApiResponse(200, { conversation }).send(res);
});

/** POST /api/conversations/:id/close — marks the conversation closed (won/lost handled via Lead.status separately). */
const closeConversation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: 'closed' } },
    { new: true }
  );
  if (!conversation) throw ApiError.notFound('Conversation not found');
  return new ApiResponse(200, { conversation }, 'Conversation closed').send(res);
});

module.exports = {
  listConversations,
  getConversation,
  sendManualReply,
  takeOverChat,
  resumeAI,
  markRead,
  closeConversation,
};
