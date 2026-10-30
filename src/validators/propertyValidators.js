const { z } = require("zod");

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id");

const createPropertySchema = z.object({
  body: z.object({
    projectName: z.string().min(1, "Project name is required").max(150),
    builderName: z.string().max(150).optional(),
    propertyType: z.string().max(60).optional(),
    bhk: z.string().max(30).optional(),
    location: z.string().max(150).optional(),
    city: z.string().max(100).optional(),
    budgetMin: z.number().nonnegative().nullable().optional(),
    budgetMax: z.number().nonnegative().nullable().optional(),
    sizeSqft: z.number().nonnegative().nullable().optional(),
    amenities: z.array(z.string().max(60)).optional(),
    parking: z.boolean().optional(),
    reraNumber: z.string().max(60).optional(),
    nearbyMetro: z.string().max(150).optional(),
    nearbySchool: z.string().max(150).optional(),
    nearbyHospital: z.string().max(150).optional(),
    mapsLink: z
      .string()
      .url("Must be a valid URL")
      .optional()
      .or(z.literal("")),
    description: z.string().max(4000).optional(),
    images: z
      .array(z.string().url("Each image must be a valid URL"))
      .optional(),
    isActive: z.boolean().optional(),
    availability: z.enum(["available", "booked", "sold"]).optional(),
    floor: z.string().max(40).optional(),
    possession: z.string().max(60).optional(),
  }),
});

const updatePropertySchema = z.object({
  params: z.object({ id: objectId }),
  body: createPropertySchema.shape.body.partial(),
});

const listPropertiesQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().optional(),
    city: z.string().optional(),
    propertyType: z.string().optional(),
    bhk: z.string().optional(),
    minBudget: z.coerce.number().nonnegative().optional(),
    maxBudget: z.coerce.number().nonnegative().optional(),
    isActive: z.coerce.boolean().optional(),
    availability: z.enum(["available", "booked", "sold"]).optional(),
    sortBy: z
      .enum(["createdAt", "updatedAt", "projectName", "budgetMin"])
      .default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});

const bulkDeleteSchema = z.object({
  body: z.object({
    ids: z.array(objectId).min(1, "At least one id is required"),
  }),
});

const importConfirmSchema = z.object({
  body: z.object({
    rows: z
      .array(
        z.object({
          projectName: z.string().min(1),
          builderName: z.string().optional().default(""),
          propertyType: z.string().optional().default(""),
          bhk: z.string().optional().default(""),
          location: z.string().optional().default(""),
          city: z.string().optional().default(""),
          budgetMin: z.number().nullable().optional(),
          budgetMax: z.number().nullable().optional(),
          sizeSqft: z.number().nullable().optional(),
          amenities: z.array(z.string()).optional().default([]),
          parking: z.boolean().optional().default(false),
          reraNumber: z.string().optional().default(""),
          nearbyMetro: z.string().optional().default(""),
          nearbySchool: z.string().optional().default(""),
          nearbyHospital: z.string().optional().default(""),
          mapsLink: z.string().optional().default(""),
          description: z.string().optional().default(""),
          images: z.array(z.string()).optional().default([]),
          availability: z
            .enum(["available", "booked", "sold"])
            .optional()
            .default("available"),
          floor: z.string().optional().default(""),
          possession: z.string().optional().default(""),
        }),
      )
      .min(1, "No rows to import"),
  }),
});

module.exports = {
  createPropertySchema,
  updatePropertySchema,
  listPropertiesQuerySchema,
  idParamSchema,
  bulkDeleteSchema,
  importConfirmSchema,
};
