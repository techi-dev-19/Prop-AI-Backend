const { z } = require('zod');

const updateSettingsSchema = z.object({
  body: z.object({
    companyName: z.string().max(150).optional(),
    logoUrl: z.string().max(500).optional(),
    geminiApiKey: z.string().max(200).optional(), // send '' to clear
    businessHours: z
      .object({
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      })
      .optional(),
    workingDays: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).optional(),
    greetingMessage: z.string().max(500).optional(),
    openingText: z.string().max(500).optional(),
    aiPaused: z.boolean().optional(),
    autoReplyEnabled: z.boolean().optional(),
    leadAlertPhone: z.string().max(30).optional(),
    leadAlertLevel: z.enum(['hot', 'hot_warm']).optional(),
    aiReplyDelaySeconds: z.number().int().min(1).max(30).optional(),
    whatsappDisconnected: z.boolean().optional(),
    dailyReportEnabled: z.boolean().optional(),
    dailyReportPhone: z.string().max(20).optional(), // send '' to clear
    dailyReportTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    referral: z
      .object({
        enabled: z.boolean().optional(),
        personName: z.string().max(80).optional(),
        contactNumber: z.string().max(20).optional(), // send '' to clear
      })
      .optional(),
    openingTemplate: z
      .object({
        name: z.string().max(150).optional(),
        language: z.string().max(20).optional(),
      })
      .optional(),
  }),
});

module.exports = { updateSettingsSchema };
