const mongoose = require("mongoose");
const OutboundJob = require("../../models/OutboundJob");
const Message = require("../../models/Message");
const Campaign = require("../../models/Campaign");
const { emitToUser } = require("../../sockets");
const logger = require("../../utils/logger");

/**
 * Meta delivery-time failures.
 *
 * Message Meta ko successfully chala jata hai (job = "sent"), phir Meta webhook
 * se batata hai ki deliver nahi hua (statuses[].status = "failed" + error code).
 * Ye file us webhook failure ko OutboundJob par laati hai, har error code ka
 * rule (retry ho sakta hai ya nahi, kitne ghante baad) decide karti hai, aur
 * "ready" contacts ko wapas queue mein daalti hai.
 */

const HOUR = 60 * 60 * 1000;

// Ek job par max kitni baar delivery-failure ke baad dobara bhejenge.
// Meta baar-baar retry karne par quality rating girata hai.
const MAX_DELIVERY_RETRIES = 2;

const RULES = {
  // Number WhatsApp par nahi hai / purana WhatsApp / nayi terms accept nahi ki
  131026: {
    retryable: false,
    cooldownMs: 0,
    label: "Number WhatsApp par nahi hai ya message undeliverable",
  },
  // Healthy ecosystem engagement — Meta ne marketing message roka
  131049: {
    retryable: true,
    cooldownMs: 24 * HOUR,
    label: "Meta ne marketing message roka (healthy ecosystem engagement)",
  },
  // User Meta ke experiment mein hai — marketing template nahi jayega
  130472: {
    retryable: false,
    cooldownMs: 0,
    label: "User Meta experiment mein hai — marketing template nahi jayega",
  },
};

// Unknown delivery error: ek ghante baad ek baar try karne dete hain
const DEFAULT_RULE = { retryable: true, cooldownMs: 1 * HOUR };

const oid = (id) => new mongoose.Types.ObjectId(String(id));

function classify(code, title) {
  const rule = RULES[String(code)];
  if (rule) return rule;
  return {
    ...DEFAULT_RULE,
    label: title ? String(title).slice(0, 200) : "WhatsApp delivery failed",
  };
}

/** Mongo expressions (aggregation) jo ready / waiting ginte hain */
function readyExpr(now) {
  return {
    $and: [
      { $eq: ["$retryable", true] },
      { $lt: [{ $ifNull: ["$deliveryRetryCount", 0] }, MAX_DELIVERY_RETRIES] },
      { $lte: ["$retryAfter", now] },
    ],
  };
}
function waitingExpr(now) {
  return {
    $and: [
      { $eq: ["$retryable", true] },
      { $lt: [{ $ifNull: ["$deliveryRetryCount", 0] }, MAX_DELIVERY_RETRIES] },
      { $gt: ["$retryAfter", now] },
    ],
  };
}

const emptySummary = () => ({
  total: 0,
  ready: 0,
  waiting: 0,
  blocked: 0,
  nextReadyAt: null,
});

/**
 * Webhook "failed" status ko job par lagao.
 * error = Meta ka statuses[].errors[0] ({ code, title, message })
 */
async function applyDeliveryFailure({ jobId, error }) {
  const job = await OutboundJob.findById(jobId).lean();
  if (!job) return null;

  const code = error?.code ? String(error.code) : "unknown";
  const rule = classify(code, error?.title || error?.message);
  const now = new Date();

  await OutboundJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "failed",
        lockedAt: null,
        deliveryFailed: true,
        deliveryFailedAt: now,
        deliveryErrorCode: code,
        retryable: rule.retryable,
        retryAfter: new Date(now.getTime() + rule.cooldownMs),
        lastError: `${rule.label} (code ${code})`,
        lastErrorCode: code,
      },
    },
  );

  // Realtime: Outreach page par row + campaign card turant update ho
  try {
    emitToUser(job.ownerId, "outreach:job", {
      jobId: String(job._id),
      campaignId: job.campaignId ? String(job.campaignId) : null,
      leadId: String(job.leadId),
      channel: job.channel || "whatsapp",
      status: "failed",
      attempts: job.attempts,
      sentAt: job.sentAt || null,
      nextRunAt: job.nextRunAt,
      lastError: `${rule.label} (code ${code})`,
    });
    if (job.campaignId) {
      const { getCampaignStats } = require("./outboundQueue");
      const stats = await getCampaignStats(job.campaignId);
      emitToUser(job.ownerId, "outreach:progress", {
        campaignId: String(job.campaignId),
        stats,
      });
      emitToUser(job.ownerId, "outreach:campaign", {
        campaignId: String(job.campaignId),
        deliveryFailure: true,
      });
    }
  } catch (err) {
    logger.warn("[delivery-failure] Could not emit realtime event", {
      error: err.message,
    });
  }

  logger.warn("[delivery-failure] Job marked failed from Meta webhook", {
    jobId: String(job._id),
    campaignId: job.campaignId ? String(job.campaignId) : null,
    code,
    retryable: rule.retryable,
  });
  return { jobId: String(job._id), code, ...rule };
}

/** Campaigns ki list ke liye: { campaignIdString: summary } */
async function summarizeForCampaigns(campaignIds) {
  const out = new Map();
  if (!campaignIds?.length) return out;

  const now = new Date();
  const rows = await OutboundJob.aggregate([
    {
      $match: {
        campaignId: { $in: campaignIds.map(oid) },
        channel: "whatsapp",
        status: "failed",
        deliveryFailed: true,
      },
    },
    {
      $group: {
        _id: "$campaignId",
        total: { $sum: 1 },
        ready: { $sum: { $cond: [readyExpr(now), 1, 0] } },
        waiting: { $sum: { $cond: [waitingExpr(now), 1, 0] } },
        nextReadyAt: {
          $min: { $cond: [waitingExpr(now), "$retryAfter", null] },
        },
      },
    },
  ]);

  for (const r of rows) {
    out.set(String(r._id), {
      total: r.total,
      ready: r.ready,
      waiting: r.waiting,
      blocked: r.total - r.ready - r.waiting,
      nextReadyAt: r.nextReadyAt || null,
    });
  }
  return out;
}

function stateOf(job, now) {
  if (!job.retryable) return "blocked";
  if ((job.deliveryRetryCount || 0) >= MAX_DELIVERY_RETRIES) return "blocked";
  return new Date(job.retryAfter) <= now ? "ready" : "waiting";
}

/** Popup ke liye: summary + har failed contact */
async function getFailureDetails(ownerId, campaignId) {
  const campaign = await Campaign.findOne({
    _id: campaignId,
    ownerId,
    deletedAt: null,
  }).lean();
  if (!campaign) return null;

  const now = new Date();
  const jobs = await OutboundJob.find({
    ownerId,
    campaignId: campaign._id,
    channel: "whatsapp",
    status: "failed",
    deliveryFailed: true,
  })
    .sort({ deliveryFailedAt: -1 })
    .limit(2000)
    .populate("leadId", "name phone")
    .lean();

  const summary = emptySummary();
  const contacts = jobs.map((j) => {
    const state = stateOf(j, now);
    summary.total += 1;
    if (state === "ready") summary.ready += 1;
    else if (state === "waiting") {
      summary.waiting += 1;
      if (!summary.nextReadyAt || j.retryAfter < summary.nextReadyAt) {
        summary.nextReadyAt = j.retryAfter;
      }
    } else summary.blocked += 1;

    const exhausted =
      j.retryable && (j.deliveryRetryCount || 0) >= MAX_DELIVERY_RETRIES;
    return {
      jobId: String(j._id),
      leadId: j.leadId?._id ? String(j.leadId._id) : null,
      name: j.leadId?.name || "(deleted lead)",
      phone: j.leadId?.phone || "",
      errorCode: j.deliveryErrorCode || j.lastErrorCode || null,
      reason: exhausted
        ? `${j.lastError || "Delivery failed"} — max retries reached`
        : j.lastError || "Delivery failed",
      failedAt: j.deliveryFailedAt,
      retryAfter: j.retryAfter,
      retryable: Boolean(j.retryable) && !exhausted,
      retryCount: j.deliveryRetryCount || 0,
      state,
    };
  });

  return {
    campaign: { _id: String(campaign._id), name: campaign.name },
    summary,
    maxRetries: MAX_DELIVERY_RETRIES,
    contacts,
  };
}

/**
 * Jo failed contacts "ready" hain (cooldown khatam + retry allowed) unhe
 * usi campaign mein wapas queue kar do. Same template, same worker.
 */
async function retryReadyFailures(ownerId, campaignId) {
  const campaign = await Campaign.findOne({
    _id: campaignId,
    ownerId,
    deletedAt: null,
  });
  if (!campaign) return null;
  if (campaign.status === "cancelled") {
    return { campaign, requeued: 0, reason: "campaign_cancelled" };
  }

  const now = new Date();
  const readyJobs = await OutboundJob.find({
    ownerId,
    campaignId: campaign._id,
    channel: "whatsapp",
    status: "failed",
    deliveryFailed: true,
    retryable: true,
    deliveryRetryCount: { $lt: MAX_DELIVERY_RETRIES },
    retryAfter: { $lte: now },
  })
    .select("_id")
    .lean();

  if (!readyJobs.length) return { campaign, requeued: 0, reason: "none_ready" };
  const ids = readyJobs.map((j) => j._id);

  // Purani failed Message ko history mein rehne do, par uska outboundJobId
  // hata do — warna startConversation use "already_started" maan lega aur
  // naya message bheje bina job ko "sent" mark kar dega.
  await Message.updateMany(
    { outboundJobId: { $in: ids } },
    { $set: { outboundJobId: null } },
  );

  const res = await OutboundJob.updateMany(
    { _id: { $in: ids }, status: "failed", deliveryFailed: true },
    {
      $set: {
        // Campaign paused hai to jobs bhi paused rahen, resume par chalenge
        status: campaign.status === "paused" ? "paused" : "pending",
        attempts: 0,
        nextRunAt: now,
        lockedAt: null,
        sentAt: null,
        lastError: null,
        lastErrorCode: null,
        deliveryFailed: false,
      },
      $inc: { deliveryRetryCount: 1 },
    },
  );

  if (res.modifiedCount && ["completed"].includes(campaign.status)) {
    campaign.status = "active";
    campaign.completedAt = null;
    await campaign.save();
  }

  return { campaign, requeued: res.modifiedCount, reason: null };
}

module.exports = {
  MAX_DELIVERY_RETRIES,
  classify,
  applyDeliveryFailure,
  summarizeForCampaigns,
  getFailureDetails,
  retryReadyFailures,
};
