const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const listFollowUpsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['pending', 'sent', 'done', 'skipped']).optional(),
    ownerId: objectId.optional(),
  }),
});

const updateFollowUpSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    status: z.enum(['pending', 'sent', 'done', 'skipped']).optional(),
    nextFollowUpDate: z.coerce.date().optional(),
    nextFollowUpMessage: z.string().max(2000).optional(),
    urgency: z.enum(['low', 'medium', 'high']).optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});

module.exports = { listFollowUpsSchema, updateFollowUpSchema, idParamSchema };
