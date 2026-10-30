const mongoose = require("mongoose");
const { Schema } = mongoose;

const emailMessageSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null, index: true },
  campaignId: { type: Schema.Types.ObjectId, ref: "Campaign", default: null, index: true },
  outboundJobId: { type: Schema.Types.ObjectId, ref: "OutboundJob", default: undefined },
  direction: { type: String, enum: ["outbound", "inbound"], required: true, index: true },
  kind: { type: String, enum: ["campaign", "reply", "received"], default: "campaign" },
  threadId: { type: Schema.Types.ObjectId, ref: "EmailMessage", default: null, index: true },
  parentMessageId: { type: Schema.Types.ObjectId, ref: "EmailMessage", default: null },
  trackingId: { type: String, default: null, index: true },
  providerMessageId: { type: String, default: null },
  rfcMessageId: { type: String, default: null },
  providerEventId: { type: String, default: undefined },
  from: { type: String, default: "" },
  to: { type: String, default: "", index: true },
  subject: { type: String, default: "" },
  text: { type: String, default: "" },
  html: { type: String, default: "" },
  status: {
    type: String,
    enum: ["queued", "sending", "sent", "delivered", "delivery_delayed", "bounced", "complained", "failed", "suppressed", "received", "cancelled"],
    default: "queued",
    index: true,
  },
  replyStatus: { type: String, enum: ["waiting", "replied"], default: "waiting", index: true },
  replyCount: { type: Number, default: 0, min: 0 },
  openedAt: { type: Date, default: null },
  clickedAt: { type: Date, default: null },
  lastReplyAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  receivedAt: { type: Date, default: null },
  errorCode: { type: String, default: null },
  errorMessage: { type: String, default: null },
  eventIds: { type: [String], default: [] },
}, { timestamps: true });

// A campaign job is the idempotency key for outbound tracking. Sparse allows
// replies/ordinary sent messages that don't originate from a queued campaign.
emailMessageSchema.index({ outboundJobId: 1 }, { unique: true, sparse: true });
emailMessageSchema.index({ providerMessageId: 1 }, { sparse: true });
emailMessageSchema.index({ providerEventId: 1 }, { unique: true, sparse: true });
emailMessageSchema.index({ ownerId: 1, direction: 1, createdAt: -1 });
emailMessageSchema.index({ ownerId: 1, direction: 1, kind: 1, replyStatus: 1, createdAt: -1 });
emailMessageSchema.index({ leadId: 1, threadId: 1, createdAt: 1 });

module.exports = mongoose.model("EmailMessage", emailMessageSchema);
