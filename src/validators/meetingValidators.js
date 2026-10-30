const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm 24hr');

const listMeetingsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['scheduled', 'visited', 'not_visited', 'rescheduled', 'cancelled']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    ownerId: objectId.optional(),
    source: z.enum(['whatsapp_ai', 'manual']).optional(),
    when: z.enum(['today', 'upcoming', 'past']).optional(),
  }),
});

const createMeetingSchema = z.object({
  body: z.object({
    leadId: objectId,
    propertyId: objectId.optional().nullable(),
    preferredDate: isoDate,
    preferredTime: timeStr,
    notes: z.string().max(1000).optional(),
  }),
});

const updateMeetingSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    propertyId: objectId.optional().nullable(),
    preferredDate: isoDate.optional(),
    preferredTime: timeStr.optional(),
    status: z.enum(['scheduled', 'visited', 'not_visited', 'rescheduled', 'cancelled']).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});

module.exports = { listMeetingsSchema, createMeetingSchema, updateMeetingSchema, idParamSchema };
