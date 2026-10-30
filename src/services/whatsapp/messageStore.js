const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');

/** Persists an outbound message record — called after a successful Meta WhatsApp Cloud API send. */
async function recordOutboundMessage({ conversationId, leadId, text, sender, whatsappMessageId, outboundJobId, aiPrompt, aiResponseRaw, intent, sentiment, mediaUrl, mediaType, quickReplies }) {
  const message = await Message.create({
    conversationId,
    leadId,
    direction: 'outbound',
    sender,
    text,
    whatsappMessageId: whatsappMessageId || null,
    outboundJobId: outboundJobId || null,
    status: 'sent',
    aiPrompt: aiPrompt || null,
    aiResponseRaw: aiResponseRaw || null,
    intent: intent || null,
    sentiment: sentiment || null,
    mediaUrl: mediaUrl || null,
    mediaType: mediaType || null,
    quickReplies: Array.isArray(quickReplies) ? quickReplies : [],
  });
  await Conversation.updateOne({ _id: conversationId }, { $set: { lastMessageAt: message.timestamp } });
  return message;
}

module.exports = { recordOutboundMessage };
