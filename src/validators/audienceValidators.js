const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const createAudienceSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, 'Audience name required').max(120),
    description: z.string().trim().max(300).optional().default(''),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional().default([]),
    source: z.enum(['selection', 'upload', 'filter']).optional().default('selection'),
    leadIds: z.array(objectId).min(1, 'Select at least one contact').max(20000),
  }),
});

const updateAudienceSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(300).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    addLeadIds: z.array(objectId).max(20000).optional(),
    removeLeadIds: z.array(objectId).max(20000).optional(),
  }),
});

const listAudiencesSchema = z.object({
  query: z.object({
    search: z.string().max(120).optional(),
  }),
});

const audienceLeadsSchema = z.object({
  params: z.object({ id: objectId }),
  query: z.object({
    channel: z.enum(['whatsapp', 'email']).optional(),
    excludeSent: z.enum(['0', '1', 'true', 'false']).optional(),
  }),
});

const idParamSchema = z.object({ params: z.object({ id: objectId }) });

module.exports = { createAudienceSchema, updateAudienceSchema, listAudiencesSchema, audienceLeadsSchema, idParamSchema };
