// const asyncHandler = require("../utils/asyncHandler");
// const ApiError = require("../utils/ApiError");
// const ApiResponse = require("../utils/ApiResponse");
// const Campaign = require("../models/Campaign");
// const Audience = require("../models/Audience");
// const EmailMessage = require("../models/EmailMessage");
// const OutboundJob = require("../models/OutboundJob");
// const { launchCampaign } = require("../services/campaign/campaignService");
// const queue = require("../services/queue/outboundQueue");
// const { emitToUser } = require("../sockets");

// /** POST /api/campaigns/launch */
// const launch = asyncHandler(async (req, res) => {
//   const { rows, leadIds, audienceId, ...config } = req.body;

//   const result = await launchCampaign({
//     ownerId: req.user.id,
//     userId: req.user.id,
//     ip: req.ip,
//     rows,
//     leadIds,
//     config: { ...config, audienceId },
//   });
//   if (audienceId) {
//     await Audience.updateOne(
//       { _id: audienceId, ownerId: req.user.id },
//       { $set: { lastUsedAt: new Date() } },
//     );
//   }

//   const { whatsapp, email } = result.queued;
//   const parts = [];
//   if (whatsapp) parts.push(`${whatsapp} WhatsApp`);
//   if (email) parts.push(`${email} email`);

//   return new ApiResponse(
//     201,
//     {
//       campaignId: result.campaign._id,
//       insertedCount: result.insertedCount,
//       skipped: result.skipped,
//       invalid: result.invalid,
//       queued: result.queued,
//       withoutEmail: result.withoutEmail,
//       withoutPhone: result.withoutPhone,
//       whatsappAvailable: result.whatsappAvailable,
//       emailAvailable: result.emailAvailable,
//       totalDays: result.totalDays,
//       firstRunAt: result.firstRunAt,
//       lastRunAt: result.lastRunAt,
//     },
//     `Campaign started: ${result.insertedCount} leads, ${parts.join(" + ")} scheduled over ${result.totalDays} day(s).`,
//   ).send(res);
// });

// /** GET /api/campaigns */
// const list = asyncHandler(async (req, res) => {
//   const campaigns = await queue.listCampaigns(req.user.id, { limit: 30 });
//   return new ApiResponse(200, { campaigns }).send(res);
// });

// /** GET /api/campaigns/:id */
// const getOne = asyncHandler(async (req, res) => {
//   const campaign = await Campaign.findOne({
//     _id: req.params.id,
//     ownerId: req.user.id,
//   }).lean();
//   if (!campaign) throw ApiError.notFound("Campaign not found");
//   const stats = await queue.getCampaignStats(campaign._id);
//   return new ApiResponse(200, { campaign: { ...campaign, stats } }).send(res);
// });

// function control(action, message) {
//   return asyncHandler(async (req, res) => {
//     const result = await action(req);
//     if (!result) throw ApiError.notFound("Campaign not found");

//     if (message === "Campaign cancelled") {
//       await EmailMessage.updateMany(
//         {
//           ownerId: req.user.id,
//           campaignId: result.campaign._id,
//           direction: "outbound",
//           kind: "campaign",
//           status: { $in: ["queued", "sending"] },
//         },
//         { $set: { status: "cancelled" } },
//       );
//     }

//     const stats = await queue.getCampaignStats(result.campaign._id);
//     emitToUser(req.user.id, "outreach:campaign", {
//       campaignId: String(result.campaign._id),
//       status: result.campaign.status,
//     });
//     emitToUser(req.user.id, "outreach:progress", {
//       campaignId: String(result.campaign._id),
//       stats,
//     });

//     return new ApiResponse(
//       200,
//       { status: result.campaign.status, affected: result.modified, stats },
//       `${message}: ${result.modified} job(s)`,
//     ).send(res);
//   });
// }

// const pause = control(
//   (req) => queue.pauseCampaign(req.user.id, req.params.id),
//   "Campaign paused",
// );
// const resume = control(
//   (req) => queue.resumeCampaign(req.user.id, req.params.id),
//   "Campaign resumed",
// );
// const cancel = control(
//   (req) => queue.cancelCampaign(req.user.id, req.params.id),
//   "Campaign cancelled",
// );
// const retry = control(
//   (req) => queue.retryFailed(req.user.id, req.params.id, req.body?.channel),
//   "Failed jobs re-queued",
// );

// /** DELETE /api/campaigns/:id — hide campaign from the list without erasing delivery history. */
// const remove = asyncHandler(async (req, res) => {
//   const campaign = await Campaign.findOne({
//     _id: req.params.id,
//     ownerId: req.user.id,
//     deletedAt: null,
//   });
//   if (!campaign) throw ApiError.notFound("Campaign not found");

//   // Stop any remaining queued sends before hiding the campaign.
//   if (["active", "paused"].includes(campaign.status)) {
//     const result = await queue.cancelCampaign(req.user.id, campaign._id);
//     if (result?.campaign) campaign.status = result.campaign.status;
//   }

//   campaign.deletedAt = new Date();
//   await campaign.save();

//   // Remove this campaign's rows from WhatsApp/Email bulk history, but do not
//   // delete any Lead/contact records from Upload Data.
//   await Promise.all([
//     OutboundJob.deleteMany({ ownerId: req.user.id, campaignId: campaign._id }),
//     EmailMessage.deleteMany({ ownerId: req.user.id, campaignId: campaign._id }),
//   ]);

//   emitToUser(req.user.id, "outreach:campaign", {
//     campaignId: String(campaign._id),
//     status: campaign.status,
//     deleted: true,
//   });
//   return new ApiResponse(
//     200,
//     { campaignId: String(campaign._id), deleted: true },
//     "Campaign removed from list",
//   ).send(res);
// });

// /** GET /api/outreach/summary — sidebar badges + page header cards */
// const summary = asyncHandler(async (req, res) => {
//   const data = await queue.getOutreachSummary(req.user.id);
//   return new ApiResponse(200, data).send(res);
// });

// /** GET /api/outreach/jobs?channel=&campaignId=&status=&page= */
// const jobs = asyncHandler(async (req, res) => {
//   const data = await queue.listJobs(req.user.id, req.query);
//   return new ApiResponse(200, data).send(res);
// });

// module.exports = {
//   launch,
//   list,
//   getOne,
//   pause,
//   resume,
//   cancel,
//   retry,
//   remove,
//   summary,
//   jobs,
// };

const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Campaign = require("../models/Campaign");
const Audience = require("../models/Audience");
const EmailMessage = require("../models/EmailMessage");
const OutboundJob = require("../models/OutboundJob");
const { launchCampaign } = require("../services/campaign/campaignService");
const queue = require("../services/queue/outboundQueue");
const deliveryFailures = require("../services/queue/deliveryFailures");
const { emitToUser } = require("../sockets");

/** POST /api/campaigns/launch */
const launch = asyncHandler(async (req, res) => {
  const { rows, leadIds, audienceId, ...config } = req.body;

  const result = await launchCampaign({
    ownerId: req.user.id,
    userId: req.user.id,
    ip: req.ip,
    rows,
    leadIds,
    config: { ...config, audienceId },
  });
  if (audienceId) {
    await Audience.updateOne(
      { _id: audienceId, ownerId: req.user.id },
      { $set: { lastUsedAt: new Date() } },
    );
  }

  const { whatsapp, email } = result.queued;
  const parts = [];
  if (whatsapp) parts.push(`${whatsapp} WhatsApp`);
  if (email) parts.push(`${email} email`);

  return new ApiResponse(
    201,
    {
      campaignId: result.campaign._id,
      insertedCount: result.insertedCount,
      skipped: result.skipped,
      invalid: result.invalid,
      queued: result.queued,
      withoutEmail: result.withoutEmail,
      withoutPhone: result.withoutPhone,
      whatsappAvailable: result.whatsappAvailable,
      emailAvailable: result.emailAvailable,
      totalDays: result.totalDays,
      firstRunAt: result.firstRunAt,
      lastRunAt: result.lastRunAt,
    },
    `Campaign started: ${result.insertedCount} leads, ${parts.join(" + ")} scheduled over ${result.totalDays} day(s).`,
  ).send(res);
});

/** GET /api/campaigns */
const list = asyncHandler(async (req, res) => {
  const campaigns = await queue.listCampaigns(req.user.id, { limit: 30 });
  return new ApiResponse(200, { campaigns }).send(res);
});

/** GET /api/campaigns/:id */
const getOne = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    ownerId: req.user.id,
  }).lean();
  if (!campaign) throw ApiError.notFound("Campaign not found");
  const stats = await queue.getCampaignStats(campaign._id);
  return new ApiResponse(200, { campaign: { ...campaign, stats } }).send(res);
});

function control(action, message) {
  return asyncHandler(async (req, res) => {
    const result = await action(req);
    if (!result) throw ApiError.notFound("Campaign not found");

    if (message === "Campaign cancelled") {
      await EmailMessage.updateMany(
        {
          ownerId: req.user.id,
          campaignId: result.campaign._id,
          direction: "outbound",
          kind: "campaign",
          status: { $in: ["queued", "sending"] },
        },
        { $set: { status: "cancelled" } },
      );
    }

    const stats = await queue.getCampaignStats(result.campaign._id);
    emitToUser(req.user.id, "outreach:campaign", {
      campaignId: String(result.campaign._id),
      status: result.campaign.status,
    });
    emitToUser(req.user.id, "outreach:progress", {
      campaignId: String(result.campaign._id),
      stats,
    });

    return new ApiResponse(
      200,
      { status: result.campaign.status, affected: result.modified, stats },
      `${message}: ${result.modified} job(s)`,
    ).send(res);
  });
}

const pause = control(
  (req) => queue.pauseCampaign(req.user.id, req.params.id),
  "Campaign paused",
);
const resume = control(
  (req) => queue.resumeCampaign(req.user.id, req.params.id),
  "Campaign resumed",
);
const cancel = control(
  (req) => queue.cancelCampaign(req.user.id, req.params.id),
  "Campaign cancelled",
);
const retry = control(
  (req) => queue.retryFailed(req.user.id, req.params.id, req.body?.channel),
  "Failed jobs re-queued",
);

/** DELETE /api/campaigns/:id — hide campaign from the list without erasing delivery history. */
const remove = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    ownerId: req.user.id,
    deletedAt: null,
  });
  if (!campaign) throw ApiError.notFound("Campaign not found");

  // Stop any remaining queued sends before hiding the campaign.
  if (["active", "paused"].includes(campaign.status)) {
    const result = await queue.cancelCampaign(req.user.id, campaign._id);
    if (result?.campaign) campaign.status = result.campaign.status;
  }

  campaign.deletedAt = new Date();
  await campaign.save();

  // Remove this campaign's rows from WhatsApp/Email bulk history, but do not
  // delete any Lead/contact records from Upload Data.
  await Promise.all([
    OutboundJob.deleteMany({ ownerId: req.user.id, campaignId: campaign._id }),
    EmailMessage.deleteMany({ ownerId: req.user.id, campaignId: campaign._id }),
  ]);

  emitToUser(req.user.id, "outreach:campaign", {
    campaignId: String(campaign._id),
    status: campaign.status,
    deleted: true,
  });
  return new ApiResponse(
    200,
    { campaignId: String(campaign._id), deleted: true },
    "Campaign removed from list",
  ).send(res);
});

/** GET /api/outreach/summary — sidebar badges + page header cards */
const summary = asyncHandler(async (req, res) => {
  const data = await queue.getOutreachSummary(req.user.id);
  return new ApiResponse(200, data).send(res);
});

/** GET /api/outreach/jobs?channel=&campaignId=&status=&page= */
const jobs = asyncHandler(async (req, res) => {
  const data = await queue.listJobs(req.user.id, req.query);
  return new ApiResponse(200, data).send(res);
});

/** GET /api/campaigns/:id/delivery-failures — Meta webhook se failed contacts + timer */
const deliveryFailuresList = asyncHandler(async (req, res) => {
  const data = await deliveryFailures.getFailureDetails(
    req.user.id,
    req.params.id,
  );
  if (!data) throw ApiError.notFound("Campaign not found");
  return new ApiResponse(200, data).send(res);
});

/** POST /api/campaigns/:id/retry-delivery-failed — sirf "ready" contacts dobara bhejo */
const retryDeliveryFailed = asyncHandler(async (req, res) => {
  const result = await deliveryFailures.retryReadyFailures(
    req.user.id,
    req.params.id,
  );
  if (!result) throw ApiError.notFound("Campaign not found");

  if (result.reason === "campaign_cancelled") {
    throw ApiError.badRequest(
      "Campaign cancel ho chuki hai, resend nahi ho sakta.",
    );
  }

  const stats = await queue.getCampaignStats(result.campaign._id);
  emitToUser(req.user.id, "outreach:campaign", {
    campaignId: String(result.campaign._id),
    status: result.campaign.status,
  });
  emitToUser(req.user.id, "outreach:progress", {
    campaignId: String(result.campaign._id),
    stats,
  });

  return new ApiResponse(
    200,
    { requeued: result.requeued, stats },
    result.requeued
      ? `${result.requeued} contact(s) dobara bhejne ke liye queue mein daal diye`
      : "Abhi koi contact ready nahi hai",
  ).send(res);
});

module.exports = {
  deliveryFailuresList,
  retryDeliveryFailed,
  launch,
  list,
  getOne,
  pause,
  resume,
  cancel,
  retry,
  remove,
  summary,
  jobs,
};
