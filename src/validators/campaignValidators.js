const { z } = require("zod");
const { importRowSchema } = require("./leadValidators");

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id");

const launchCampaignSchema = z.object({
  body: z.object({
    rows: z.array(importRowSchema).min(1).max(5000).optional(),
    leadIds: z.array(objectId).min(1).max(5000).optional(),
    audienceId: objectId.optional(),
    name: z.string().trim().min(1, "Campaign name required").max(120),
    channels: z.object({ whatsapp: z.boolean(), email: z.boolean() }).refine((c) => c.whatsapp || c.email, "Kam se kam ek channel chuno"),
    dailyLimit: z.number().int().min(1).max(5000).default(100),
    sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "sendTime must be HH:mm").default("10:00"),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    emailTemplateId: objectId.optional(),
    emailSubject: z.string().trim().max(200).optional().default(""),
    emailBody: z.string().trim().max(5000).optional().default(""),
    whatsappTemplateName: z.string().trim().max(200).optional().default(""),
    whatsappTemplateLanguage: z.string().trim().max(30).optional().default("en_US"),
    whatsappTemplateCategory: z.string().trim().max(40).optional().default(""),
    whatsappTemplateHeaderImageUrl: z.string().url().max(2000).optional().or(z.literal("")).default(""),
    whatsappTemplateBody: z.string().trim().max(1024).optional().default(""),
    // Rest of the approved template, so the chat history shows the full message.
    whatsappTemplateHeader: z.string().trim().max(200).optional().default(""),
    whatsappTemplateFooter: z.string().trim().max(200).optional().default(""),
    whatsappTemplateButtons: z.array(z.string().trim().max(60)).max(10).optional().default([]),
    whatsappTemplateVariables: z.array(z.object({
      index: z.number().int().min(1).max(10),
      source: z.enum(["name", "phone", "email", "static"]),
      value: z.string().max(1000).optional().default(""),
    })).max(10).optional().default([]),
  }).superRefine((b, ctx) => {
    if (!b.rows?.length && !b.leadIds?.length) {
      ctx.addIssue({ code: "custom", path: ["leadIds"], message: "Select at least one saved lead." });
    }
    if (b.rows?.length && b.leadIds?.length) {
      ctx.addIssue({ code: "custom", path: ["leadIds"], message: "Send either saved lead IDs or imported rows, not both." });
    }
    if (b.channels.email && !b.emailTemplateId) {
      if (!b.emailSubject) ctx.addIssue({ code: "custom", path: ["emailSubject"], message: "Email subject required" });
      if (!b.emailBody) ctx.addIssue({ code: "custom", path: ["emailBody"], message: "Email body required" });
    }
    if (b.channels.whatsapp && !b.whatsappTemplateName) {
      ctx.addIssue({ code: "custom", path: ["whatsappTemplateName"], message: "Select an approved WhatsApp template." });
    }
  }),
});

const campaignIdSchema = z.object({
  params: z.object({ id: objectId }),
});

const retrySchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({ channel: z.enum(["whatsapp", "email"]).optional() })
    .optional()
    .default({}),
});

const listJobsQuerySchema = z.object({
  query: z.object({
    channel: z.enum(["whatsapp", "email"]).optional(),
    campaignId: objectId.optional(),
    status: z
      .enum([
        "pending",
        "scheduled",
        "processing",
        "sent",
        "failed",
        "paused",
        "cancelled",
      ])
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
});

module.exports = {
  launchCampaignSchema,
  campaignIdSchema,
  retrySchema,
  listJobsQuerySchema,
};
