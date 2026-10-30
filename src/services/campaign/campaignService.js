const Campaign = require("../../models/Campaign");
const EmailTemplate = require("../../models/EmailTemplate");
const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const AuditLog = require("../../models/AuditLog");
const ApiError = require("../../utils/ApiError");
const { importLeadRows } = require("../leads/leadImportService");
const { scheduleCampaignJobs, todayIST } = require("../queue/outboundQueue");
const { emitToUser } = require("../../sockets");

/**
 * Launches a campaign against already-imported lead IDs. Legacy `rows` support
 * remains for older clients, but the CRM UI only uploads leads in the Leads area.
 */
async function launchCampaign({ ownerId, userId, ip, rows, leadIds, config }) {
  const selectedChannels = config.channels || {};
  if (!selectedChannels.whatsapp && !selectedChannels.email) {
    throw ApiError.badRequest("Kam se kam ek channel chuno.");
  }

  let selectedEmailTemplate = null;
  if (selectedChannels.email && config.emailTemplateId) {
    selectedEmailTemplate = await EmailTemplate.findOne({ _id: config.emailTemplateId, ownerId });
    if (!selectedEmailTemplate) throw ApiError.badRequest("Selected email template nahi mila. Template list refresh karein.");
    // Use saved server-side content rather than trusting a modified client payload.
    config.emailSubject = selectedEmailTemplate.subject;
    config.emailBody = selectedEmailTemplate.body;
    config.emailImageUrl = selectedEmailTemplate.imageUrl || "";
  }

  let leads = [];
  let skipped = 0;
  let invalid = 0;
  if (Array.isArray(leadIds) && leadIds.length) {
    if (new Set(leadIds.map(String)).size !== leadIds.length) {
      throw ApiError.badRequest("Selected list mein duplicate lead IDs hain.");
    }
    leads = await Lead.find({ ownerId, _id: { $in: leadIds } }).sort({ createdAt: 1 });
    if (!leads.length) throw ApiError.badRequest("Selected leads nahi mili. List refresh karke dobara choose karein.");
    skipped = leadIds.length - leads.length;
  } else {
    const eligible = (rows || []).some((row) =>
      (selectedChannels.whatsapp && String(row.phone || "").trim()) ||
      (selectedChannels.email && String(row.email || "").trim())
    );
    if (!eligible) throw ApiError.badRequest("Selected channel ke liye koi phone/email contact nahi mila.");
    const result = await importLeadRows(ownerId, rows || []);
    leads = result.inserted;
    skipped = result.skipped;
    invalid = result.invalid;
    if (!leads.length) {
      throw ApiError.badRequest("Koi nayi lead insert nahi hui — saari rows duplicate ya invalid thi.");
    }
  }

  const whatsappLeads = leads.filter((lead) => selectedChannels.whatsapp && Boolean(lead.phone));
  const emailLeads = leads.filter((lead) => selectedChannels.email && Boolean(lead.email));
  if (selectedChannels.whatsapp && !config.whatsappTemplateName) {
    throw ApiError.badRequest("Bulk WhatsApp ke liye Meta ka approved template select karein.");
  }
  if (selectedChannels.whatsapp && !whatsappLeads.length && !selectedChannels.email) {
    throw ApiError.badRequest("Selected leads mein valid WhatsApp numbers nahi hain.");
  }
  if (selectedChannels.email && !emailLeads.length && !selectedChannels.whatsapp) {
    throw ApiError.badRequest("Selected leads mein valid email addresses nahi hain.");
  }
  if (selectedChannels.email && !config.emailSubject?.trim()) {
    throw ApiError.badRequest("Email subject required.");
  }
  if (selectedChannels.email && !config.emailBody?.trim()) {
    throw ApiError.badRequest("Email body required.");
  }

  // Only queue contacts that match the selected channel; contact rows themselves remain in CRM.
  const eligibleLeads = leads.filter((lead) =>
    (selectedChannels.whatsapp && Boolean(lead.phone)) ||
    (selectedChannels.email && Boolean(lead.email))
  );
  if (!eligibleLeads.length) {
    throw ApiError.badRequest("Selected channel ke liye matching contact fields nahi hain.");
  }

  const conversationLeads = eligibleLeads.filter((lead) => Boolean(lead.phone));
  if (conversationLeads.length) {
    await Conversation.bulkWrite(conversationLeads.map((lead) => ({
      updateOne: {
        filter: { ownerId, leadId: lead._id },
        update: { $setOnInsert: { ownerId, leadId: lead._id } },
        upsert: true,
      },
    })), { ordered: false });
  }

  const today = todayIST();
  const startDate = config.startDate && config.startDate >= today ? config.startDate : today;
  const campaign = await Campaign.create({
    ownerId,
    name: config.name,
    audienceId: config.audienceId || null,
    channels: selectedChannels,
    dailyLimit: config.dailyLimit,
    sendTime: config.sendTime,
    startDate,
    whatsappTemplate: selectedChannels.whatsapp ? {
      name: config.whatsappTemplateName,
      language: config.whatsappTemplateLanguage || "en_US",
      category: config.whatsappTemplateCategory || "",
      variables: Array.isArray(config.whatsappTemplateVariables) ? config.whatsappTemplateVariables : [],
      headerImageUrl: config.whatsappTemplateHeaderImageUrl || "",
      body: config.whatsappTemplateBody || "",
      header: config.whatsappTemplateHeader || "",
      footer: config.whatsappTemplateFooter || "",
      buttons: (config.whatsappTemplateButtons || []).filter(Boolean).slice(0, 10),
    } : undefined,
    email: {
      templateId: selectedEmailTemplate?._id || null,
      templateName: selectedEmailTemplate?.name || "",
      subject: config.emailSubject || "",
      body: config.emailBody || "",
      imageUrl: config.emailImageUrl || "",
    },
    totalLeads: eligibleLeads.length,
  });

  const plan = await scheduleCampaignJobs({
    campaign,
    leads: eligibleLeads.map((lead) => ({
      _id: lead._id,
      hasPhone: Boolean(lead.phone),
      hasEmail: Boolean(lead.email),
      email: lead.email || "",
      name: lead.name || "",
    })),
  });

  campaign.leadsWithoutEmail = selectedChannels.email ? eligibleLeads.filter((lead) => !lead.email).length : 0;
  campaign.totalDays = plan.totalDays;
  campaign.firstRunAt = plan.firstRunAt;
  campaign.lastRunAt = plan.lastRunAt;
  await campaign.save();

  await AuditLog.create({
    userId,
    action: "campaign.launch",
    entityType: "Campaign",
    entityId: campaign._id,
    meta: {
      leads: eligibleLeads.length,
      selectedLeadIds: Array.isArray(leadIds) ? leadIds.length : 0,
      skipped,
      invalid,
      channels: selectedChannels,
      dailyLimit: config.dailyLimit,
      sendTime: config.sendTime,
      whatsappTemplateName: config.whatsappTemplateName || null,
    },
    ip,
  });

  emitToUser(ownerId, "outreach:campaign", { campaignId: String(campaign._id), status: "active" });

  return {
    campaign,
    insertedCount: eligibleLeads.length,
    skipped,
    invalid,
    queued: { whatsapp: plan.whatsapp, email: plan.email },
    withoutEmail: campaign.leadsWithoutEmail,
    withoutPhone: eligibleLeads.filter((lead) => !lead.phone).length,
    whatsappAvailable: eligibleLeads.filter((lead) => Boolean(lead.phone)).length,
    emailAvailable: eligibleLeads.filter((lead) => Boolean(lead.email)).length,
    totalDays: plan.totalDays,
    firstRunAt: plan.firstRunAt,
    lastRunAt: plan.lastRunAt,
  };
}

module.exports = { launchCampaign };
