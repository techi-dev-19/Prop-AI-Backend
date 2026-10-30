// const mongoose = require("mongoose");
// const { Schema } = mongoose;

// /**
//  * Bulk outreach ki persistent queue (WhatsApp + Email).
//  * Har (lead, channel) ke liye ek job. Worker (services/queue/bulkWorker.js)
//  * inhe ek-ek karke, controlled speed se uthata hai.
//  * Server restart hone par bhi jobs DB mein safe rehte hain.
//  *
//  * Per-day scheduling: campaign launch par har job ka `nextRunAt` us din ke
//  * send-time par set hota hai. Worker sirf `nextRunAt <= now` wale jobs uthata
//  * hai, isliye future-day ke jobs apne aap us din tak "scheduled" rehte hain.
//  */
// const outboundJobSchema = new Schema(
//   {
//     batchId: { type: String, required: true, index: true },
//     ownerId: {
//       type: Schema.Types.ObjectId,
//       ref: "User",
//       required: true,
//       index: true,
//     },
//     leadId: {
//       type: Schema.Types.ObjectId,
//       ref: "Lead",
//       required: true,
//       index: true,
//     },

//     // 'whatsapp' | 'email'. Purane (pre-campaign) jobs ko boot par migrate
//     // karke 'whatsapp' set kiya jata hai (bulkWorker.startBulkWorker).
//     channel: {
//       type: String,
//       enum: ["whatsapp", "email"],
//       default: "whatsapp",
//       index: true,
//     },
//     // Same din ke jobs mein WhatsApp (0) pehle, Email (1) baad mein chalta hai.
//     priority: { type: Number, default: 0 },

//     // Null = purana / single-lead job jiska koi campaign nahi hai.
//     campaignId: {
//       type: Schema.Types.ObjectId,
//       ref: "Campaign",
//       default: null,
//       index: true,
//     },
//     // Campaign ke andar lead ka order (0-based) + kaun sa din (1-based)
//     seq: { type: Number, default: 0 },
//     dayNumber: { type: Number, default: 1 },
//     // Original schedule (retry par nextRunAt badalta hai, ye nahi)
//     scheduledFor: { type: Date, default: Date.now },

//     status: {
//       type: String,
//       enum: ["pending", "processing", "sent", "failed", "cancelled", "paused"],
//       default: "pending",
//     },

//     attempts: { type: Number, default: 0 },
//     maxAttempts: { type: Number, default: 3 },

//     // Retry / backoff / schedule ke liye: job isse pehle nahi uthega
//     nextRunAt: { type: Date, default: Date.now },

//     // Worker ne job kab uthaya (stuck job pehchanne ke liye)
//     lockedAt: { type: Date, default: null },
//     sentAt: { type: Date, default: null },

//     lastError: { type: String, default: null },
//     lastErrorCode: { type: String, default: null },
//   },
//   { timestamps: true },
// );

// // Worker ka main query: status=pending + channel + nextRunAt <= now
// outboundJobSchema.index({ status: 1, channel: 1, nextRunAt: 1 });
// // Batch / campaign progress ke liye
// outboundJobSchema.index({ batchId: 1, status: 1 });
// outboundJobSchema.index({ campaignId: 1, channel: 1, status: 1 });
// // Outreach page ki list (owner + channel, schedule order)
// outboundJobSchema.index({ ownerId: 1, channel: 1, scheduledFor: 1, seq: 1 });

// module.exports = mongoose.model("OutboundJob", outboundJobSchema);

const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Bulk outreach ki persistent queue (WhatsApp + Email).
 * Har (lead, channel) ke liye ek job. Worker (services/queue/bulkWorker.js)
 * inhe ek-ek karke, controlled speed se uthata hai.
 * Server restart hone par bhi jobs DB mein safe rehte hain.
 *
 * Per-day scheduling: campaign launch par har job ka `nextRunAt` us din ke
 * send-time par set hota hai. Worker sirf `nextRunAt <= now` wale jobs uthata
 * hai, isliye future-day ke jobs apne aap us din tak "scheduled" rehte hain.
 */
const outboundJobSchema = new Schema(
  {
    batchId: { type: String, required: true, index: true },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    leadId: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true,
    },

    // 'whatsapp' | 'email'. Purane (pre-campaign) jobs ko boot par migrate
    // karke 'whatsapp' set kiya jata hai (bulkWorker.startBulkWorker).
    channel: {
      type: String,
      enum: ["whatsapp", "email"],
      default: "whatsapp",
      index: true,
    },
    // Same din ke jobs mein WhatsApp (0) pehle, Email (1) baad mein chalta hai.
    priority: { type: Number, default: 0 },

    // Null = purana / single-lead job jiska koi campaign nahi hai.
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "Campaign",
      default: null,
      index: true,
    },
    // Campaign ke andar lead ka order (0-based) + kaun sa din (1-based)
    seq: { type: Number, default: 0 },
    dayNumber: { type: Number, default: 1 },
    // Original schedule (retry par nextRunAt badalta hai, ye nahi)
    scheduledFor: { type: Date, default: Date.now },

    status: {
      type: String,
      enum: ["pending", "processing", "sent", "failed", "cancelled", "paused"],
      default: "pending",
    },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },

    // Retry / backoff / schedule ke liye: job isse pehle nahi uthega
    nextRunAt: { type: Date, default: Date.now },

    // Worker ne job kab uthaya (stuck job pehchanne ke liye)
    lockedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },

    lastError: { type: String, default: null },
    lastErrorCode: { type: String, default: null },

    // Meta webhook se aaya delivery-time failure (message accept hua, par
    // deliver nahi hua). Details: services/queue/deliveryFailures.js
    deliveryFailed: { type: Boolean, default: false },
    deliveryFailedAt: { type: Date, default: null },
    deliveryErrorCode: { type: String, default: null },
    // false = is number par dobara bhejne ka fayda nahi (131026, 130472)
    retryable: { type: Boolean, default: true },
    // Is time ke baad hi dobara bheja ja sakta hai (Meta cooldown)
    retryAfter: { type: Date, default: null },
    deliveryRetryCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Worker ka main query: status=pending + channel + nextRunAt <= now
outboundJobSchema.index({ status: 1, channel: 1, nextRunAt: 1 });
// Batch / campaign progress ke liye
outboundJobSchema.index({ batchId: 1, status: 1 });
outboundJobSchema.index({ campaignId: 1, channel: 1, status: 1 });
// Delivery-failure popup / summary
outboundJobSchema.index({ campaignId: 1, deliveryFailed: 1, retryAfter: 1 });
// Outreach page ki list (owner + channel, schedule order)
outboundJobSchema.index({ ownerId: 1, channel: 1, scheduledFor: 1, seq: 1 });

module.exports = mongoose.model("OutboundJob", outboundJobSchema);
