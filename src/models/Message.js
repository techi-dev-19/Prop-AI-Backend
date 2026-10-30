const mongoose = require('mongoose');
const { Schema } = mongoose;

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },

    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    sender: { type: String, enum: ['ai', 'broker', 'customer'], required: true },

    text: { type: String, required: true },

    // Media sent by the sales agent (image / document / video) so the
    // dashboard chat can render it.
    mediaUrl: { type: String, default: null },
    mediaType: { type: String, enum: ['image', 'document', 'video', null], default: null },
    // Quick-reply buttons shown with this message (for the dashboard preview).
    quickReplies: [{ type: String }],

    // Optional link to the durable outreach job that caused this outbound send.
    // Allows campaign retries/restarts to avoid duplicating a previously stored send.
    outboundJobId: { type: Schema.Types.ObjectId, ref: 'OutboundJob', default: null },

    // Set for messages that actually traversed WhatsApp; used for de-duplicating
    // webhook retries. Sparse+unique so it's only enforced when present.
    whatsappMessageId: { type: String, default: null },

    // Meta accepts a send first and later reports delivered/read/failed via
    // webhook status events. Keep that lifecycle on the message record.
    status: { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed'], default: 'sent' },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },

    // AI trace fields - populated only for AI-generated outbound messages
    aiPrompt: { type: String, default: null },
    aiResponseRaw: { type: Schema.Types.Mixed, default: null },
    intent: { type: String, default: null },
    sentiment: { type: String, default: null },

    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

messageSchema.index({ conversationId: 1, timestamp: 1 });
messageSchema.index({ outboundJobId: 1 }, { unique: true, partialFilterExpression: { outboundJobId: { $type: 'objectId' } } });
messageSchema.index(
  { whatsappMessageId: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model('Message', messageSchema);
