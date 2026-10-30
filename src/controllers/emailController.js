const mongoose = require("mongoose");
const axios = require("axios");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const EmailMessage = require("../models/EmailMessage");
const Lead = require("../models/Lead");
const Meeting = require("../models/Meeting");
const { isBrevoConfigured, getFromAddress, sendDirectEmail, makeReplyAddress } = require("../services/email/mailer");
const env = require("../config/env");
const logger = require("../utils/logger");
const { emitToUser } = require("../sockets");

function ownerFilter(req) {
  return { ownerId: req.user.id };
}

/** Safe, non-secret email integration status for Settings. */
const status = asyncHandler(async (req, res) => {
  const configured = isBrevoConfigured();
  const inboundRepliesConfigured = Boolean(env.brevo.inboundDomain && env.brevo.webhookSecret);
  return new ApiResponse(200, {
    provider: "Brevo API",
    configured,
    fromAddress: getFromAddress() || null,
    inboundRepliesConfigured,
    inboundDomain: env.brevo.inboundDomain || null,
    note: !configured
      ? "Set BREVO_API_KEY, BREVO_FROM_EMAIL and BREVO_FROM_NAME on the backend, then authenticate the sender domain in Brevo."
      : !inboundRepliesConfigured
        ? "Brevo sending credentials are configured. Add EMAIL_INBOUND_DOMAIN and BREVO_WEBHOOK_SECRET and configure transactional + inbound-parsing webhooks to enable dashboard replies."
        : "Brevo sender values and inbound-reply settings are present. Verify sender authentication, inbound MX records and both webhook configurations in Brevo.",
  }).send(res);
});

/**
 * GET /api/email/replies — every campaign email in a spreadsheet-like view,
 * including leads that have not replied yet. Filters are always owner-scoped.
 */
const listReplies = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const filter = { ...ownerFilter(req), direction: "outbound", kind: "campaign" };
  const state = String(req.query.state || "");
  if (state === "replied") filter.replyStatus = "replied";
  else if (state === "waiting") {
    filter.replyStatus = "waiting";
    filter.status = { $in: ["sent", "delivered", "delivery_delayed"] };
  }
  else if (["sent", "delivered", "delivery_delayed", "bounced", "complained", "failed", "suppressed"].includes(state)) {
    if (state === "failed") filter.status = { $in: ["failed", "complained", "suppressed"] };
    else filter.status = state;
  }
  if (req.query.campaignId && mongoose.isValidObjectId(req.query.campaignId)) filter.campaignId = req.query.campaignId;
  const search = String(req.query.search || "").trim().slice(0, 120);
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { to: new RegExp(escaped, "i") },
      { subject: new RegExp(escaped, "i") },
    ];
  }

  const campaignBase = { ...ownerFilter(req), direction: "outbound", kind: "campaign" };
  const [items, total, campaignTotal, replied, waiting, queued, bounced, failed] = await Promise.all([
    EmailMessage.find(filter)
      .populate("leadId", "name phone email city status")
      .populate("campaignId", "name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    EmailMessage.countDocuments(filter),
    EmailMessage.countDocuments(campaignBase),
    EmailMessage.countDocuments({ ...campaignBase, replyStatus: "replied" }),
    EmailMessage.countDocuments({ ...campaignBase, replyStatus: "waiting", status: { $in: ["sent", "delivered", "delivery_delayed"] } }),
    EmailMessage.countDocuments({ ...campaignBase, status: { $in: ["queued", "sending"] } }),
    EmailMessage.countDocuments({ ...campaignBase, status: "bounced" }),
    EmailMessage.countDocuments({ ...campaignBase, status: { $in: ["failed", "complained", "suppressed"] } }),
  ]);

  const pageLeadIds = items.map((item) => item.leadId?._id).filter(Boolean);
  const recentVisits = pageLeadIds.length ? await Meeting.find({ ownerId: req.user.id, leadId: { $in: pageLeadIds } })
    .select("leadId status preferredDate preferredTime propertyId")
    .populate("propertyId", "projectName city")
    .sort({ preferredDate: -1, updatedAt: -1 })
    .lean() : [];
  const visitByLead = new Map();
  for (const visit of recentVisits) {
    const key = String(visit.leadId);
    if (!visitByLead.has(key)) visitByLead.set(key, visit);
  }

  return new ApiResponse(200, {
    items: items.map((item) => {
      const lead = item.leadId || null;
      const visit = lead?._id ? visitByLead.get(String(lead._id)) || null : null;
      return {
        ...item,
        lead,
        campaign: item.campaignId || null,
        leadId: lead?._id || item.leadId || null,
        campaignId: item.campaignId?._id || item.campaignId || null,
        availableChannels: { whatsapp: Boolean(lead?.phone), email: Boolean(lead?.email) },
        siteVisit: visit,
        hasReply: item.replyStatus === "replied" || item.replyCount > 0,
        responseLabel: item.replyStatus === "replied" || item.replyCount > 0 ? "Replied" : "No reply yet",
      };
    }),
    summary: { total: campaignTotal, replied, waiting, queued, bounced, failed },
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  }).send(res);
});

const getThread = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.badRequest("Invalid email thread id");
  const message = await EmailMessage.findOne({ _id: req.params.id, ...ownerFilter(req), direction: "outbound" }).lean();
  if (!message) throw ApiError.notFound("Email thread not found");
  const rootId = message.threadId || message._id;
  const [root, messages] = await Promise.all([
    EmailMessage.findOne({ _id: rootId, ...ownerFilter(req) }).populate("leadId", "name phone email city").populate("campaignId", "name").lean(),
    EmailMessage.find({ ...ownerFilter(req), $or: [{ _id: rootId }, { threadId: rootId }] }).sort({ createdAt: 1 }).lean(),
  ]);
  return new ApiResponse(200, { root, messages }).send(res);
});

/** POST /api/email/replies/:id/reply — send a human reply from the dashboard. */
const replyToThread = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.badRequest("Invalid email thread id");
  const text = String(req.body?.text || "").trim();
  if (!text) throw ApiError.badRequest("Reply message is required");
  if (text.length > 10000) throw ApiError.badRequest("Reply must be 10,000 characters or less");

  const selected = await EmailMessage.findOne({ _id: req.params.id, ...ownerFilter(req), direction: "outbound" });
  if (!selected) throw ApiError.notFound("Email thread not found");
  const rootId = selected.threadId || selected._id;
  const [root, lead, latestInbound] = await Promise.all([
    EmailMessage.findOne({ _id: rootId, ...ownerFilter(req) }),
    Lead.findOne({ _id: selected.leadId, ownerId: req.user.id }),
    EmailMessage.findOne({ ...ownerFilter(req), threadId: rootId, direction: "inbound" }).sort({ createdAt: -1 }),
  ]);
  if (!root || !lead || !lead.email) throw ApiError.badRequest("Is email thread ke liye valid lead email nahi mila");

  const trackingId = require("crypto").randomBytes(16).toString("hex");
  const subject = /^re:/i.test(root.subject || "") ? root.subject : `Re: ${root.subject || "Your enquiry"}`;
  const refs = [root.rfcMessageId, latestInbound?.rfcMessageId].filter(Boolean).join(" ");
  const outbound = new EmailMessage({
    ownerId: req.user.id,
    leadId: lead._id,
    campaignId: root.campaignId || undefined,
    direction: "outbound",
    kind: "reply",
    threadId: rootId,
    parentMessageId: latestInbound?._id || root._id,
    trackingId,
    from: getFromAddress(),
    to: lead.email,
    subject,
    text,
    status: "queued",
    replyStatus: "waiting",
  });
  await outbound.save();
  try {
    outbound.status = "sending";
    await outbound.save();
    const headers = {};
    if (latestInbound?.rfcMessageId) headers["In-Reply-To"] = latestInbound.rfcMessageId;
    if (refs) headers.References = refs;
    const sent = await sendDirectEmail({
      to: lead.email,
      subject,
      text,
      replyTo: makeReplyAddress(trackingId),
      headers,
      tags: [
        { name: "product", value: "propai" },
        { name: "propai_message_id", value: String(outbound._id) },
      ],
      idempotencyKey: `propai-reply-${outbound._id}`,
    });
    await EmailMessage.updateOne({ _id: outbound._id }, {
      $set: { providerMessageId: sent.providerMessageId, rfcMessageId: sent.rfcMessageId || sent.providerMessageId, sentAt: outbound.sentAt || new Date() },
    });
    await EmailMessage.updateOne({ _id: outbound._id, status: { $in: ["queued", "sending"] } }, {
      $set: { status: "sent" },
    });
    emitToUser(req.user.id, "email:reply-sent", { threadId: String(rootId), messageId: String(outbound._id) });
    return new ApiResponse(201, { message: await EmailMessage.findById(outbound._id).lean() }, "Reply sent").send(res);
  } catch (err) {
    await EmailMessage.updateOne({ _id: outbound._id }, { $set: { status: "failed", errorCode: String(err.code || "EMAIL_SEND_FAILED"), errorMessage: String(err.message || "Email send failed").slice(0, 500) } });
    logger.error("[email] Dashboard reply send failed", { userId: String(req.user.id), messageId: String(outbound._id), error: err.message });
    throw new ApiError(502, `Email send nahi ho paya: ${String(err.message || "Brevo API error").slice(0, 220)}`);
  }
});

module.exports = { status, listReplies, getThread, replyToThread };
