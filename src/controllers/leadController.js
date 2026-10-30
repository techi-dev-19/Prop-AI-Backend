const { Parser: CsvParser } = require("json2csv");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Lead = require("../models/Lead");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const EmailMessage = require("../models/EmailMessage");
const OutboundJob = require("../models/OutboundJob");
const Meeting = require("../models/Meeting");
const AuditLog = require("../models/AuditLog");
const {
  parseLeadFile,
  parseLeadText,
  analyzeRows,
} = require("../services/csv/leadImporter");
const { importLeadRows } = require("../services/leads/leadImportService");
const { toWhatsAppNumber } = require("../services/whatsapp/metaWhatsappClient");
const { enqueueLeads } = require("../services/queue/outboundQueue");

/**
 * Scoping helper: brokers only ever see/act on their own leads.
 * Admins can pass ?ownerId= to view a specific broker's leads; builders
 * don't own leads at all (they view leads via property-match reporting,
 * not this resource) — enforced in the route via roleGuard.
 */
function scopeToOwner(req) {
  if (req.user.role === "admin" && req.query.ownerId) {
    return { ownerId: req.query.ownerId };
  }
  return { ownerId: req.user.id };
}

const { LEAD_SCORE, HOT_SCORE, leadTypeFor } = require("../config/leadRules");

const AUTO_REPLY_PATTERN =
  /(automatic reply|auto.?reply|out of office|do not reply|no.?reply|i am an ai|virtual assistant|leave a message|not monitored|on leave until)/i;

/**
 * Who has genuinely replied, and who has a site visit. A human-looking reply
 * counts at once; if every message looks like an auto-responder it only
 * counts after 3 of them (so an out-of-office mail is not a buyer).
 */
async function getQualificationSets(req, replyChannel = "") {
  const ownerFilter = scopeToOwner(req);
  const ownedIds = await Lead.find(ownerFilter).distinct("_id");
  const owned = new Set(ownedIds.map(String));
  const repliedIds = new Set();

  if (replyChannel !== "whatsapp") {
    // Only count genuine inbound email replies. Exclude automated replies using
    // the same policy as WhatsApp, so out-of-office messages do not qualify a lead.
    const emailReplies = await EmailMessage.find({
      ...ownerFilter,
      direction: "inbound",
      kind: "received",
      leadId: { $ne: null },
    })
      .select("leadId subject text")
      .lean();
    const groupedEmail = new Map();
    for (const email of emailReplies) {
      if (!email.leadId || !owned.has(String(email.leadId))) continue;
      const id = String(email.leadId);
      if (!groupedEmail.has(id)) groupedEmail.set(id, { human: 0, auto: 0 });
      const group = groupedEmail.get(id);
      const content = `${email.subject || ""} ${email.text || ""}`;
      if (AUTO_REPLY_PATTERN.test(content)) group.auto += 1;
      else group.human += 1;
    }
    for (const [id, group] of groupedEmail) {
      if (group.human >= 1 || group.auto >= 3) repliedIds.add(id);
    }
  }
  if (replyChannel !== "email") {
    const inbound = await Message.find({
      leadId: { $in: ownedIds },
      direction: "inbound",
      sender: "customer",
    })
      .select("leadId text")
      .lean();
    const grouped = new Map();
    for (const message of inbound) {
      const key = String(message.leadId);
      if (!grouped.has(key)) grouped.set(key, { human: 0, auto: 0 });
      const item = grouped.get(key);
      if (AUTO_REPLY_PATTERN.test(message.text || "")) item.auto += 1;
      else item.human += 1;
    }
    for (const [id, item] of grouped)
      if (item.human >= 1 || item.auto >= 3) repliedIds.add(id);
  }

  const meetingOwner = ownerFilter.ownerId;
  const visitLeadIds = await Meeting.distinct("leadId", {
    ownerId: meetingOwner,
    status: { $ne: "cancelled" },
  });
  const visitIds = new Set(
    visitLeadIds.map(String).filter((id) => owned.has(id)),
  );
  return { repliedIds: [...repliedIds], visitIds: [...visitIds] };
}

function buildStageClause(stage, { repliedIds, visitIds, replyChannel }) {
  const replied = { _id: { $in: repliedIds } };
  const visit = { $or: [{ _id: { $in: visitIds } }, { status: "site_visit" }] };
  // A channel view (WhatsApp → Leads) only shows people who replied on that channel.
  const channelGuard = replyChannel ? [replied] : [];
  if (stage === "hot")
    return { $and: [replied, { leadScore: { $gt: HOT_SCORE } }] };
  if (stage === "visit") return { $and: [visit, ...channelGuard] };
  // The "all" tab and channel-specific Leads pages show every genuine reply,
  // even while AI scoring is low or still running. The score remains useful for
  // classification; Hot and Visit tabs retain their stricter rules.
  return { $and: [{ $or: [replied, visit] }, ...channelGuard] };
}

/**
 * POST /api/leads/import/preview
 * Upload a CSV, get back every row annotated as valid/invalid/duplicate.
 * Nothing is written to the DB at this step.
 */
const previewImport = asyncHandler(async (req, res) => {
  if (!req.file)
    throw ApiError.badRequest('CSV file is required (field name: "file")');

  let rows;
  try {
    rows = parseLeadFile(req.file.buffer, req.file.originalname);
  } catch (err) {
    throw ApiError.badRequest(err.message);
  }

  const { rows: analyzed, summary } = await analyzeRows(req.user.id, rows);

  return new ApiResponse(200, { rows: analyzed, summary }, "CSV parsed").send(
    res,
  );
});

/**
 * POST /api/leads/import/parse-text
 * Body: { text } — har line mein name + phone (+ email) kisi bhi order mein.
 * Response CSV preview jaisa hi hai (valid / invalid / duplicate per row).
 */
const previewText = asyncHandler(async (req, res) => {
  const rows = parseLeadText(req.body.text);
  if (!rows.length)
    throw ApiError.badRequest("No leads found in the pasted text");

  const { rows: analyzed, summary } = await analyzeRows(req.user.id, rows);
  return new ApiResponse(200, { rows: analyzed, summary }, "Text parsed").send(
    res,
  );
});

/**
 * POST /api/leads/import/confirm
 * Client sends back the rows it wants imported (typically the "valid" subset
 * from the preview step, possibly after manual edits). Duplicate-safe via
 * insertMany({ ordered: false }) + the unique (ownerId, phone) index.
 */
const confirmImport = asyncHandler(async (req, res) => {
  const { rows } = req.body;
  const ownerId = req.user.id;

  const {
    inserted,
    skipped,
    invalid = 0,
    existingIds = [],
  } = await importLeadRows(ownerId, rows);

  await AuditLog.create({
    userId: req.user.id,
    action: "lead.import",
    entityType: "Lead",
    meta: { insertedCount: inserted.length, skipped },
    ip: req.ip,
  });

  // Uploading data never sends a WhatsApp or email message. The user selects
  // contacts and starts a channel-specific campaign later from WhatsApp/Email.
  return new ApiResponse(
    201,
    {
      insertedCount: inserted.length,
      skipped,
      invalid,
      leadIds: inserted.map((lead) => lead._id),
      existingLeadIds: existingIds,
    },
    `Imported ${inserted.length} leads${skipped ? `, skipped ${skipped} duplicates` : ""}. No messages were sent.`,
  ).send(res);
});

/**
 * POST /api/leads/start-conversations
 * Body: { leadIds: [...] }
 * Kicks off the opening WhatsApp message for a batch of leads (typically
 * the leadIds just returned by /import/confirm, once the broker clicks
 * "Start") — or for any lead whose conversation hasn't been started yet.
 * Safe to call more than once: startConversation() no-ops for leads that
 * already have messages.
 */

const startConversations = asyncHandler(async (req, res) => {
  const { leadIds } = req.body;

  if (!Array.isArray(leadIds) || !leadIds.length) {
    throw ApiError.badRequest("leadIds is required");
  }

  const ownerId = req.user.id;

  // Only allow leads belonging to the logged-in broker.
  const leads = await Lead.find({
    _id: { $in: leadIds },
    ownerId,
    phone: { $type: "string" },
  }).select("_id");

  if (!leads.length) {
    throw ApiError.badRequest("No valid leads found");
  }

  const validLeadIds = leads.map((lead) => lead._id);

  // Only queue leads that have a conversation.
  const conversations = await Conversation.find({
    ownerId,
    leadId: { $in: validLeadIds },
  })
    .select("leadId")
    .lean();

  const leadIdsWithConversation = conversations.map(
    (conversation) => conversation.leadId,
  );

  const queueResult = await enqueueLeads({
    ownerId,
    leadIds: leadIdsWithConversation,
  });

  return new ApiResponse(
    200,
    {
      queued: queueResult.queued,
      skipped: queueResult.skipped,
      batchId: queueResult.batchId,
    },
    `Queued ${queueResult.queued} lead(s) for WhatsApp messaging`,
  ).send(res);
});

// const startConversations = asyncHandler(async (req, res) => {
//   const { leadIds } = req.body;
//   if (!Array.isArray(leadIds) || !leadIds.length) throw ApiError.badRequest('leadIds is required');

//   const ownerId = req.user.id;
//   const leads = await Lead.find({ _id: { $in: leadIds }, ownerId });
//   const leadById = new Map(leads.map((l) => [l._id.toString(), l]));

//   const conversations = await Conversation.find({ leadId: { $in: leads.map((l) => l._id) } });

//   let started = 0;
//   for (const conversation of conversations) {
//     const lead = leadById.get(conversation.leadId.toString());
//     if (!lead) continue;
//     started += 1;
//     conversationEngine.startConversation({ lead, conversation }).catch((err) =>
//       logger.error(`[leads] Failed to start WhatsApp conversation for lead ${lead._id}`, { error: err.message })
//     );
//   }

//   return new ApiResponse(200, { queued: started }, `Starting conversations for ${started} lead(s)`).send(res);
// });

/**
 * POST /api/leads
 */

const createLead = asyncHandler(async (req, res) => {
  let phone = null;
  try {
    if (req.body.phone && String(req.body.phone).trim())
      phone = toWhatsAppNumber(req.body.phone);
  } catch (err) {
    throw ApiError.badRequest(err.message || "Enter a valid phone number");
  }
  const email =
    String(req.body.email || "")
      .trim()
      .toLowerCase() || undefined;
  if (!phone && !email) throw ApiError.badRequest("Phone or email is required");

  if (phone && (await Lead.findOne({ ownerId: req.user.id, phone }))) {
    throw ApiError.conflict("A lead with this phone number already exists");
  }
  if (email && (await Lead.findOne({ ownerId: req.user.id, email }))) {
    throw ApiError.conflict("A lead with this email address already exists");
  }

  const name =
    String(req.body.name || "").trim() ||
    (email
      ? email
          .split("@")[0]
          .replace(/[._+-]+/g, " ")
          .trim()
      : `Lead ${String(phone || "")
          .replace(/\D/g, "")
          .slice(-4)}`) ||
    "New lead";
  const lead = await Lead.create({
    ...req.body,
    name: name.slice(0, 150),
    phone,
    email,
    ownerId: req.user.id,
  });
  if (phone)
    await Conversation.updateOne(
      { ownerId: lead.ownerId, leadId: lead._id },
      { $setOnInsert: { ownerId: lead.ownerId, leadId: lead._id } },
      { upsert: true },
    );

  return new ApiResponse(
    201,
    {
      lead,
      queued: 0,
      batchId: null,
      availableChannels: { whatsapp: Boolean(phone), email: Boolean(email) },
    },
    "Lead saved. No message was sent; launch a campaign when ready.",
  ).send(res);
});

/**
 * GET /api/leads
 */
const listLeads = asyncHandler(async (req, res) => {
  const {
    page,
    limit,
    search,
    status,
    city,
    tag,
    sortBy,
    sortOrder,
    qualifiedOnly,
  } = req.query;

  const filter = { ...scopeToOwner(req) };
  const idClauses = [];
  if (status) filter.status = status;
  const channel = ["whatsapp", "email"].includes(
    String(req.query.channel || ""),
  )
    ? String(req.query.channel)
    : "";
  const delivery = ["sent", "unsent"].includes(String(req.query.delivery || ""))
    ? String(req.query.delivery)
    : "";
  if (channel === "whatsapp") filter.phone = { $type: "string", $ne: "" };
  if (channel === "email") filter.email = { $type: "string", $ne: "" };
  if (channel && delivery) {
    const sentLeadIds = await OutboundJob.distinct("leadId", {
      ownerId: req.user.id,
      channel,
      status: "sent",
    });
    idClauses.push({
      _id: delivery === "sent" ? { $in: sentLeadIds } : { $nin: sentLeadIds },
    });
  }

  // Audience / explicit selection: ?ids=a,b,c (used by bulk messaging to show
  // an audience's contacts). Only well-formed ids are accepted.
  if (req.query.ids) {
    const ids = String(req.query.ids)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
    idClauses.push({ _id: { $in: ids } });
  }

  // Qualified Leads (and WhatsApp → Leads / Email → Leads):
  //   all   = any genuine customer reply (any score), or a booked site visit
  //   hot   = replied + score > 60
  //   visit = site visit booked (AI on WhatsApp, or added by the broker)
  const replyChannel = ["whatsapp", "email"].includes(
    String(req.query.replyChannel || ""),
  )
    ? String(req.query.replyChannel)
    : "";
  let qualifiedCounts = null;
  if (
    String(qualifiedOnly || "") === "1" ||
    String(qualifiedOnly || "").toLowerCase() === "true"
  ) {
    const { repliedIds, visitIds } = await getQualificationSets(
      req,
      replyChannel,
    );
    const stageClause = (name) =>
      buildStageClause(name, { repliedIds, visitIds, replyChannel });
    idClauses.push(
      stageClause(
        ["hot", "visit"].includes(req.query.stage) ? req.query.stage : "all",
      ),
    );
    const ownerOnly = scopeToOwner(req);
    const [all, hot, visit] = await Promise.all([
      Lead.countDocuments({ ...ownerOnly, ...stageClause("all") }),
      Lead.countDocuments({ ...ownerOnly, ...stageClause("hot") }),
      Lead.countDocuments({ ...ownerOnly, ...stageClause("visit") }),
    ]);
    qualifiedCounts = {
      all,
      hot,
      visit,
      leadScore: LEAD_SCORE,
      hotScore: HOT_SCORE,
    };
  }
  if (idClauses.length) filter.$and = [...(filter.$and || []), ...idClauses];
  if (city) filter.city = new RegExp(`^${city}$`, "i");
  if (tag) filter.tags = tag;
  if (req.query.file)
    filter.importFile =
      req.query.file === "__manual__" ? { $in: [null, ""] } : req.query.file;
  if (search) {
    const escaped = String(search)
      .trim()
      .slice(0, 120)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped) {
      const re = new RegExp(escaped, "i");
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { city: re },
        { address: re },
        { jobTitle: re },
        { notes: re },
        { requirements: re },
      ];
    }
  }

  // _id as a tie-breaker keeps the order (and so the Sr. no.) stable between pages.
  const sort = {
    [sortBy]: sortOrder === "asc" ? 1 : -1,
    _id: sortOrder === "asc" ? 1 : -1,
  };

  // Contacts sheet: ordered ids only, for "select Sr. no. X to Y" across pages.
  if (["1", "true"].includes(String(req.query.idsOnly || ""))) {
    const rows = await Lead.find(filter)
      .sort(sort)
      .limit(20000)
      .select("_id")
      .lean();
    return new ApiResponse(200, {
      ids: rows.map((row) => row._id),
      total: rows.length,
    }).send(res);
  }

  const ownerFilter = scopeToOwner(req);
  const hasPhone = { phone: { $type: "string", $ne: "" } };
  const hasEmail = { email: { $type: "string", $ne: "" } };
  const noPhone = {
    $or: [{ phone: { $exists: false } }, { phone: null }, { phone: "" }],
  };
  const noEmail = {
    $or: [{ email: { $exists: false } }, { email: null }, { email: "" }],
  };
  const [
    leads,
    total,
    allLeads,
    whatsappAvailable,
    emailAvailable,
    bothAvailable,
    whatsappOnly,
    emailOnly,
    siteVisits,
  ] = await Promise.all([
    Lead.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Lead.countDocuments(filter),
    Lead.countDocuments(ownerFilter),
    Lead.countDocuments({ ...ownerFilter, ...hasPhone }),
    Lead.countDocuments({ ...ownerFilter, ...hasEmail }),
    Lead.countDocuments({ ...ownerFilter, ...hasPhone, ...hasEmail }),
    Lead.countDocuments({ ...ownerFilter, ...hasPhone, ...noEmail }),
    Lead.countDocuments({ ...ownerFilter, ...hasEmail, ...noPhone }),
    Lead.countDocuments({ ...ownerFilter, status: "site_visit" }),
  ]);

  const allOwnedLeadIds = await Lead.find(ownerFilter).distinct("_id");
  const [whatsappReplies, emailReplies] = await Promise.all([
    Message.distinct("leadId", {
      leadId: { $in: allOwnedLeadIds },
      direction: "inbound",
      sender: "customer",
    }),
    EmailMessage.distinct("leadId", {
      ...ownerFilter,
      leadId: { $ne: null },
      direction: "inbound",
      kind: "received",
    }),
  ]);

  // conversationStarted lets the frontend show a "Start" button for any lead
  // that's been imported/created but whose opening WhatsApp message hasn't
  // gone out yet (see POST /leads/start-conversations).
  const pageLeadIds = leads.map((lead) => lead._id);
  const [conversations, outboundJobs, emailEvents, whatsappMessages, visits] =
    await Promise.all([
      Conversation.find(
        { ownerId: req.user.id, leadId: { $in: pageLeadIds } },
        "leadId lastMessageAt",
      ).lean(),
      OutboundJob.find({ ownerId: req.user.id, leadId: { $in: pageLeadIds } })
        .sort({ updatedAt: -1 })
        .lean(),
      EmailMessage.find({ ownerId: req.user.id, leadId: { $in: pageLeadIds } })
        .sort({ createdAt: -1 })
        .lean(),
      Message.find({ leadId: { $in: pageLeadIds } })
        .sort({ timestamp: -1 })
        .lean(),
      Meeting.aggregate([
        {
          $match: {
            ownerId: req.user._id || req.user.id,
            leadId: { $in: pageLeadIds },
          },
        },
        { $sort: { preferredDate: -1, preferredTime: -1, updatedAt: -1 } },
        {
          $group: {
            _id: "$leadId",
            siteVisitCount: { $sum: 1 },
            latestVisit: { $first: "$$ROOT" },
          },
        },
      ]),
    ]);
  const lastMessageByLead = new Map(
    conversations.map((c) => [String(c.leadId), c.lastMessageAt]),
  );
  const outboundMessageLeadIds = new Set(
    whatsappMessages
      .filter((message) => message.direction === "outbound")
      .map((message) => String(message.leadId)),
  );
  const channelStatus = new Map();
  for (const job of outboundJobs) {
    // A pre-created/no-attempt queue row is not a real send result. Legacy
    // non-campaign failures came from the old auto-start flow; don't label a
    // never-messaged contact as failed unless an outbound record exists.
    if (job.status !== "sent" && !(Number(job.attempts || 0) > 0)) continue;
    if (
      job.channel === "whatsapp" &&
      job.status === "failed" &&
      !job.campaignId &&
      !outboundMessageLeadIds.has(String(job.leadId))
    )
      continue;
    const key = String(job.leadId);
    if (!channelStatus.has(key)) channelStatus.set(key, {});
    const state = channelStatus.get(key);
    if (!state[job.channel]) state[job.channel] = job;
  }
  const emailState = new Map();
  for (const event of emailEvents) {
    const key = String(event.leadId);
    if (!emailState.has(key))
      emailState.set(key, {
        sentAt: null,
        status: "not_sent",
        replyAt: null,
        replyCount: 0,
        subject: "",
      });
    const state = emailState.get(key);
    if (event.direction === "inbound" && event.kind === "received") {
      state.replyCount += 1;
      if (!state.replyAt) state.replyAt = event.receivedAt || event.createdAt;
    } else if (
      event.direction === "outbound" &&
      event.kind === "campaign" &&
      state.status === "not_sent"
    ) {
      state.status = event.status;
      state.sentAt = event.sentAt || null;
      state.subject = event.subject || "";
    }
  }
  const whatsappState = new Map();
  for (const message of whatsappMessages) {
    const key = String(message.leadId);
    if (!whatsappState.has(key))
      whatsappState.set(key, {
        sentAt: null,
        sentStatus: "not_sent",
        replyAt: null,
        replyCount: 0,
      });
    const state = whatsappState.get(key);
    if (message.direction === "inbound" && message.sender === "customer") {
      state.replyCount += 1;
      if (!state.replyAt)
        state.replyAt = message.timestamp || message.createdAt;
    } else if (message.direction === "outbound" && !state.sentAt) {
      state.sentAt = message.timestamp || message.createdAt;
      state.sentStatus = message.status || "sent";
    }
  }
  const visitState = new Map(visits.map((row) => [String(row._id), row]));
  const leadsWithStatus = leads.map((lead) => {
    const key = String(lead._id);
    const wa = whatsappState.get(key) || {};
    const email = emailState.get(key) || {};
    const jobs = channelStatus.get(key) || {};
    const waJob = jobs.whatsapp;
    const emailJob = jobs.email;
    const visit = visitState.get(key);
    return {
      ...lead,
      conversationStarted: Boolean(lastMessageByLead.get(key)),
      whatsappMessageStatus: waJob?.status || wa.sentStatus || "not_sent",
      whatsappSentAt: waJob?.sentAt || wa.sentAt || null,
      whatsappReplyAt: wa.replyAt || null,
      whatsappReplyCount: wa.replyCount || 0,
      emailMessageStatus: emailJob?.status || email.status || "not_sent",
      emailSentAt: emailJob?.sentAt || email.sentAt || null,
      emailReplyAt: email.replyAt || null,
      emailReplyCount: email.replyCount || 0,
      lastReplyAt:
        [wa.replyAt, email.replyAt]
          .filter(Boolean)
          .sort((a, b) => new Date(b) - new Date(a))[0] || null,
      replyReceived: Boolean(wa.replyAt || email.replyAt),
      siteVisitCount: visit?.siteVisitCount || 0,
      latestSiteVisit: visit?.latestVisit || null,
      leadType: leadTypeFor({
        score: lead.leadScore,
        hasVisit:
          Boolean(visit?.siteVisitCount) || lead.status === "site_visit",
        replied: Boolean(wa.replyAt || email.replyAt),
      }),
    };
  });

  return new ApiResponse(200, {
    leads: leadsWithStatus,
    summary: {
      total: allLeads,
      whatsappAvailable,
      emailAvailable,
      bothAvailable,
      whatsappOnly,
      emailOnly,
      siteVisits,
      whatsappReplies: whatsappReplies.length,
      emailReplies: emailReplies.length,
      repliedContacts: new Set(
        [...whatsappReplies, ...emailReplies].map(String),
      ).size,
      qualified: qualifiedCounts,
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/**
 * GET /api/leads/import-files — the sheets contacts were uploaded from, newest first.
 */
const listImportFiles = asyncHandler(async (req, res) => {
  const ownerFilter = scopeToOwner(req);
  const ownerId = new (require("mongoose").Types.ObjectId)(
    String(ownerFilter.ownerId),
  );
  const rows = await Lead.aggregate([
    { $match: { ownerId } },
    {
      $group: {
        _id: { $ifNull: ["$importFile", ""] },
        count: { $sum: 1 },
        whatsapp: {
          $sum: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ["$phone", ""] } }, 0] },
              1,
              0,
            ],
          },
        },
        email: {
          $sum: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ["$email", ""] } }, 0] },
              1,
              0,
            ],
          },
        },
        lastAt: { $max: "$createdAt" },
      },
    },
    { $sort: { lastAt: -1 } },
  ]);
  const files = rows.map((row) => ({
    file: row._id || "__manual__",
    label: row._id || "Manually added / older contacts",
    count: row.count,
    whatsapp: row.whatsapp,
    email: row.email,
    lastAt: row.lastAt,
  }));
  return new ApiResponse(200, { files }).send(res);
});

/**
 * GET /api/leads/:id
 */
const getLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, ...scopeToOwner(req) });
  if (!lead) throw ApiError.notFound("Lead not found");
  return new ApiResponse(200, { lead }).send(res);
});

/**
 * PATCH /api/leads/:id
 */
const updateLead = asyncHandler(async (req, res) => {
  const updates = { ...req.body };
  const currentLead = await Lead.findOne({
    _id: req.params.id,
    ...scopeToOwner(req),
  });
  if (!currentLead) throw ApiError.notFound("Lead not found");
  if (Object.prototype.hasOwnProperty.call(updates, "phone")) {
    if (updates.phone && String(updates.phone).trim()) {
      try {
        updates.phone = toWhatsAppNumber(updates.phone);
      } catch (err) {
        throw ApiError.badRequest(err.message || "Enter a valid phone number");
      }
    } else updates.phone = null;
    if (updates.phone) {
      const dupe = await Lead.findOne({
        ownerId: req.user.id,
        phone: updates.phone,
        _id: { $ne: req.params.id },
      });
      if (dupe)
        throw ApiError.conflict("Another lead already uses this phone number");
    }
  }
  if (Object.prototype.hasOwnProperty.call(updates, "email")) {
    updates.email =
      String(updates.email || "")
        .trim()
        .toLowerCase() || null;
    if (updates.email) {
      const duplicateEmail = await Lead.findOne({
        ownerId: req.user.id,
        email: updates.email,
        _id: { $ne: req.params.id },
      });
      if (duplicateEmail)
        throw ApiError.conflict("Another lead already uses this email address");
    }
  }

  const finalPhone = Object.prototype.hasOwnProperty.call(updates, "phone")
    ? updates.phone
    : currentLead.phone;
  const finalEmail = Object.prototype.hasOwnProperty.call(updates, "email")
    ? updates.email
    : currentLead.email;
  if (!String(finalPhone || "").trim() && !String(finalEmail || "").trim()) {
    throw ApiError.badRequest(
      "Lead ke paas kam se kam phone ya email rehna chahiye",
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(updates, "name") &&
    !String(updates.name || "").trim()
  ) {
    updates.name =
      (finalEmail
        ? String(finalEmail)
            .split("@")[0]
            .replace(/[._+-]+/g, " ")
            .trim()
        : `Lead ${String(finalPhone || "")
            .replace(/\D/g, "")
            .slice(-4)}`) || "New lead";
    updates.name = updates.name.slice(0, 150);
  }

  const lead = await Lead.findOneAndUpdate(
    { _id: req.params.id, ...scopeToOwner(req) },
    { $set: updates },
    { new: true, runValidators: true },
  );
  if (!lead) throw ApiError.notFound("Lead not found");

  // WhatsApp contacts gain a conversation shell when a number is added later;
  // do not enqueue unsolicited messages here—leave sending to the user/campaign.
  if (lead.phone) {
    await Conversation.updateOne(
      { ownerId: lead.ownerId, leadId: lead._id },
      { $setOnInsert: { ownerId: lead.ownerId, leadId: lead._id } },
      { upsert: true },
    );
  }

  return new ApiResponse(200, { lead }, "Lead updated").send(res);
});

/**
 * DELETE /api/leads/:id
 */
const deleteLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOneAndDelete({
    _id: req.params.id,
    ...scopeToOwner(req),
  });
  if (!lead) throw ApiError.notFound("Lead not found");

  // Remove campaign tracker rows for this contact as well. The lead itself is
  // already deleted above; cleanup is owner-scoped wherever the model supports it.
  await Promise.all([
    Conversation.deleteMany({ ownerId: lead.ownerId, leadId: lead._id }),
    OutboundJob.deleteMany({ ownerId: lead.ownerId, leadId: lead._id }),
    EmailMessage.deleteMany({ ownerId: lead.ownerId, leadId: lead._id }),
    Message.deleteMany({ leadId: lead._id }),
  ]);

  return new ApiResponse(
    200,
    null,
    "Contact and related campaign rows deleted",
  ).send(res);
});

/**
 * POST /api/leads/bulk-delete
 */
const bulkDeleteLeads = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const filter = { _id: { $in: ids }, ...scopeToOwner(req) };
  const leads = await Lead.find(filter).select("_id ownerId").lean();
  const leadIds = leads.map((lead) => lead._id);
  if (!leadIds.length) {
    return new ApiResponse(
      200,
      { deletedCount: 0 },
      "No matching contacts found",
    ).send(res);
  }

  const result = await Lead.deleteMany({
    _id: { $in: leadIds },
    ...scopeToOwner(req),
  });
  const ownerIds = [...new Set(leads.map((lead) => String(lead.ownerId)))];
  await Promise.all([
    Conversation.deleteMany({ leadId: { $in: leadIds } }),
    Message.deleteMany({ leadId: { $in: leadIds } }),
    OutboundJob.deleteMany({
      leadId: { $in: leadIds },
      ownerId: { $in: ownerIds },
    }),
    EmailMessage.deleteMany({
      leadId: { $in: leadIds },
      ownerId: { $in: ownerIds },
    }),
  ]);

  return new ApiResponse(
    200,
    { deletedCount: result.deletedCount },
    "Contacts and related campaign rows deleted",
  ).send(res);
});

/**
 * POST /api/leads/:id/tags   body: { add?: string[], remove?: string[] }
 */
const updateTags = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, ...scopeToOwner(req) });
  if (!lead) throw ApiError.notFound("Lead not found");

  const { add = [], remove = [] } = req.body;
  let tags = new Set(lead.tags);
  add.forEach((t) => tags.add(t));
  remove.forEach((t) => tags.delete(t));
  lead.tags = Array.from(tags);
  await lead.save();

  return new ApiResponse(200, { lead }, "Tags updated").send(res);
});

/**
 * GET /api/leads/export
 * Exports the current filtered view as a downloadable CSV (same filters as listLeads).
 */
const exportLeads = asyncHandler(async (req, res) => {
  const { search, status, city, tag } = req.query;
  const filter = { ...scopeToOwner(req) };
  if (status) filter.status = status;
  if (city) filter.city = new RegExp(`^${city}$`, "i");
  if (tag) filter.tags = tag;
  if (search) {
    const escaped = String(search)
      .trim()
      .slice(0, 120)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped) {
      const re = new RegExp(escaped, "i");
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { city: re },
        { notes: re },
        { requirements: re },
      ];
    }
  }

  const leads = await Lead.find(filter).sort({ createdAt: -1 }).lean();

  const fields = [
    "name",
    "phone",
    "email",
    "city",
    "location",
    "address",
    "jobTitle",
    "budgetMin",
    "budgetMax",
    "occupation",
    "age",
    "source",
    "status",
    "leadScore",
    "tags",
    "notes",
    "requirements",
    "createdAt",
  ];
  const parser = new CsvParser({ fields });
  const csv = parser.parse(
    leads.map((l) => ({ ...l, tags: (l.tags || []).join("|") })),
  );

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="leads-export-${Date.now()}.csv"`,
  );
  return res.send(csv);
});

module.exports = {
  previewImport,
  previewText,
  confirmImport,
  startConversations,
  createLead,
  listLeads,
  listImportFiles,
  getLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  updateTags,
  exportLeads,
};
