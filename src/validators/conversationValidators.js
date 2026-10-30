const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const listConversationsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    filter: z.enum(['unread', 'hot', 'warm', 'cold', 'site_visit', 'closed', 'lost']).optional(),
    search: z.string().optional(),
    leadId: objectId.optional(),
    ownerId: objectId.optional(),
  }),
});

const getConversationSchema = z.object({
  params: z.object({ id: objectId }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    ownerId: objectId.optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: objectId }),
  query: z.object({ ownerId: objectId.optional() }).optional(),
});

const sendManualReplySchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({ text: z.string().min(1, 'Message text is required').max(4096) }),
});

module.exports = {
  listConversationsSchema,
  getConversationSchema,
  idParamSchema,
  sendManualReplySchema,
};
