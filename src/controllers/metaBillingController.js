const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const Campaign = require("../models/Campaign");
const OutboundJob = require("../models/OutboundJob");
const { getMetaUsage } = require("../services/meta/metaBillingService");

/**
 * GET /api/analytics/meta-billing?range=this_month|last_month|30d|7d
 * Meta's approximate WhatsApp charges plus a per-campaign estimate
 * (messages this CRM sent × Meta's average cost for that template category).
 */
const getMetaBilling = asyncHandler(async (req, res) => {
  const range = ["this_month", "last_month", "30d", "7d"].includes(
    req.query.range,
  )
    ? req.query.range
    : "this_month";
  const usage = await getMetaUsage({ range });

  const ownerId =
    req.user.role === "admin" && req.query.ownerId
      ? req.query.ownerId
      : req.user.id;
  const sentRows = await OutboundJob.aggregate([
    {
      $match: {
        ownerId: new (require("mongoose").Types.ObjectId)(String(ownerId)),
        channel: "whatsapp",
        status: "sent",
        campaignId: { $ne: null },
        sentAt: {
          $gte: new Date(usage.period.start),
          $lt: new Date(usage.period.end),
        },
      },
    },
    { $group: { _id: "$campaignId", sent: { $sum: 1 } } },
  ]);
  const campaigns = sentRows.length
    ? await Campaign.find({ _id: { $in: sentRows.map((r) => r._id) } })
        .select(
          "name whatsappTemplate.name whatsappTemplate.category createdAt",
        )
        .lean()
    : [];
  const avgByCategory = new Map(
    (usage.byCategory || []).map((c) => [c.category, c.avgCost]),
  );
  const campaignCosts = sentRows
    .map((row) => {
      const campaign = campaigns.find((c) => String(c._id) === String(row._id));
      const category = String(
        campaign?.whatsappTemplate?.category || "MARKETING",
      ).toUpperCase();
      const rate = avgByCategory.get(category) || 0;
      return {
        campaignId: row._id,
        name: campaign?.name || "Campaign",
        template: campaign?.whatsappTemplate?.name || "",
        category,
        sent: row.sent,
        estimatedCost: usage.costAvailable
          ? Math.round(row.sent * rate * 100) / 100
          : null,
        createdAt: campaign?.createdAt || null,
      };
    })
    .sort(
      (a, b) =>
        (b.estimatedCost || 0) - (a.estimatedCost || 0) || b.sent - a.sent,
    );

  return new ApiResponse(200, { ...usage, campaigns: campaignCosts }).send(res);
});

module.exports = { getMetaBilling };
