const { Parser: CsvParser } = require("json2csv");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Property = require("../models/Property");
const AuditLog = require("../models/AuditLog");
const {
  parseCsvBuffer,
  analyzeRows,
} = require("../services/csv/propertyImporter");
const { uploadBufferToCloudinary } = require("../services/cloudinaryUpload");
const {
  extractPropertyDataWithAI,
} = require("../services/brochureAiExtractor");
const { upsertSite } = require("../services/sites/siteBrochure");

/**
 * Scoping: builders only see/manage their own inventory. Admins can pass
 * ?ownerId= to inspect a specific builder's listings. Brokers get read-only
 * access across all active properties (needed later for AI property matching)
 * — enforced per-route below, not here.
 */
function scopeToOwner(req) {
  if (req.user.role === "admin" && req.query.ownerId) {
    return { ownerId: req.query.ownerId };
  }
  return { ownerId: req.user.id };
}

/**
 * POST /api/properties/import/preview
 */
const previewImport = asyncHandler(async (req, res) => {
  if (!req.file)
    throw ApiError.badRequest('CSV file is required (field name: "file")');

  let rows;
  try {
    rows = parseCsvBuffer(req.file.buffer);
  } catch (err) {
    throw ApiError.badRequest(err.message);
  }

  const { rows: analyzed, summary } = await analyzeRows(req.user.id, rows);
  return new ApiResponse(200, { rows: analyzed, summary }, "CSV parsed").send(
    res,
  );
});

/**
 * POST /api/properties/import/confirm
 */
const confirmImport = asyncHandler(async (req, res) => {
  const { rows } = req.body;
  const ownerId = req.user.id;

  const docs = rows.map((r) => ({
    ownerId,
    projectName: r.projectName,
    builderName: r.builderName || undefined,
    propertyType: r.propertyType || undefined,
    bhk: r.bhk || undefined,
    location: r.location || undefined,
    city: r.city || undefined,
    budgetMin: r.budgetMin ?? null,
    budgetMax: r.budgetMax ?? null,
    sizeSqft: r.sizeSqft ?? null,
    amenities: r.amenities || [],
    parking: !!r.parking,
    reraNumber: r.reraNumber || undefined,
    nearbyMetro: r.nearbyMetro || undefined,
    nearbySchool: r.nearbySchool || undefined,
    nearbyHospital: r.nearbyHospital || undefined,
    mapsLink: r.mapsLink || undefined,
    description: r.description || undefined,
    images: r.images || [],
    availability: r.availability || "available",
    floor: r.floor || "",
    possession: r.possession || "",
  }));

  const inserted = await Property.insertMany(docs, { ordered: false });

  await AuditLog.create({
    userId: req.user.id,
    action: "property.import",
    entityType: "Property",
    meta: { insertedCount: inserted.length },
    ip: req.ip,
  });

  return new ApiResponse(
    201,
    { insertedCount: inserted.length },
    `Imported ${inserted.length} properties`,
  ).send(res);
});

/**
 * POST /api/properties/brochure
 *
 * Upload:
 * - 1 brochure PDF
 * - up to 10 property images
 *
 * Files are received by Multer and uploaded to Cloudinary.
 */

const uploadBrochureAndImages = asyncHandler(async (req, res) => {
  const brochureFile = req.files?.brochure?.[0];
  const imageFiles = req.files?.images || [];

  if (!brochureFile) {
    throw ApiError.badRequest(
      "Please upload a brochure PDF. Property details will be extracted from the brochure.",
    );
  }

  // ==========================================
  // 1. Upload brochure to Cloudinary
  // ==========================================
  let brochure = null;

  const brochureResult = await uploadBufferToCloudinary(brochureFile.buffer, {
    folder: "properties/brochures",
    resourceType: "raw",
  });

  brochure = {
    url: brochureResult.secure_url,
    publicId: brochureResult.public_id,
    originalName: brochureFile.originalname,
  };

  // ==========================================
  // 2. Upload property images
  // ==========================================
  const images = [];

  for (const imageFile of imageFiles) {
    const result = await uploadBufferToCloudinary(imageFile.buffer, {
      folder: "properties/images",
      resourceType: "image",
    });

    images.push(result.secure_url);
  }

  // ==========================================
  // 3. Extract property data using Gemini
  // ==========================================
  let extractedData;

  try {
    extractedData = await extractPropertyDataWithAI(brochure.url);

    console.log("[brochure-ai] Extracted property data:", extractedData);
  } catch (error) {
    console.error("[brochure-ai] Extraction failed:", error);

    throw ApiError.badRequest(
      "Brochure uploaded successfully, but property details could not be extracted from the brochure. Please try another PDF.",
    );
  }

  // ==========================================
  // 4. Validate required AI extracted data
  // ==========================================
  if (!extractedData?.projectName) {
    console.error(
      "[brochure-ai] projectName missing from extraction:",
      extractedData,
    );

    throw ApiError.badRequest(
      "Could not detect the project name from the brochure. Please upload a brochure containing clear project details.",
    );
  }

  // ==========================================
  // 5. Create property AFTER AI extraction
  // ==========================================
  const propertyData = {
    ownerId: req.user.id,

    projectName: extractedData.projectName,
    builderName: extractedData.builderName,
    propertyType: extractedData.propertyType,
    bhk: extractedData.bhk,
    location: extractedData.location,
    city: extractedData.city,

    budgetMin: extractedData.budgetMin,
    budgetMax: extractedData.budgetMax,

    sizeSqft: extractedData.sizeSqft,

    amenities: Array.isArray(extractedData.amenities)
      ? extractedData.amenities
      : [],

    parking: Boolean(extractedData.parking),

    reraNumber: extractedData.reraNumber,

    nearbyMetro: extractedData.nearbyMetro,
    nearbySchool: extractedData.nearbySchool,
    nearbyHospital: extractedData.nearbyHospital,

    mapsLink: extractedData.mapsLink,
    description: extractedData.description,

    images,

    brochureUrl: brochure.url,
    brochureName: brochure.originalName,

    dataSource: "brochure",

    brochureExtractionStatus: "completed",
    brochureExtractedAt: new Date(),
  };

  // ==========================================
  // 6. Save property to MongoDB
  // ==========================================
  const property = await Property.create(propertyData);

  // Keep the brochure and photos on the project's own site too, so every
  // unit row of this project (and the AI) uses this site's brochure.
  try {
    await upsertSite({
      ownerId: req.user.id,
      name: property.projectName,
      city: property.city || "",
      location: property.location || "",
      brochure: {
        url: brochure.url,
        name: brochure.originalName,
        publicId: brochure.publicId,
      },
      images,
    });
  } catch (err) {
    console.error(
      "[brochure-ai] Could not save brochure on site:",
      err.message,
    );
  }

  // ==========================================
  // 7. Return response
  // ==========================================
  return new ApiResponse(
    201,
    {
      property,
      brochure,
      images,
    },
    "Brochure uploaded and property created successfully",
  ).send(res);
});

/**
 * POST /api/properties
 */
const createProperty = asyncHandler(async (req, res) => {
  const property = await Property.create({
    ...req.body,
    ownerId: req.user.id,
  });
  return new ApiResponse(201, { property }, "Property created").send(res);
});

/**
 * GET /api/properties
 * Brokers get read-only access to ALL active properties (across builders) so
 * they can browse inventory for matching; builders/admins are scoped to their own.
 */
const listProperties = asyncHandler(async (req, res) => {
  const {
    page,
    limit,
    search,
    city,
    propertyType,
    bhk,
    minBudget,
    maxBudget,
    isActive,
    availability,
    sortBy,
    sortOrder,
  } = req.query;

  const filter = {};
  if (req.user.role === "broker") {
    filter.isActive = true; // brokers only ever see live inventory
  } else {
    Object.assign(filter, scopeToOwner(req));
    if (isActive !== undefined) filter.isActive = isActive;
  }

  if (city) filter.city = new RegExp(`^${city}$`, "i");
  if (propertyType) filter.propertyType = new RegExp(`^${propertyType}$`, "i");
  if (bhk) filter.bhk = bhk;
  if (availability)
    filter.availability =
      availability === "available"
        ? { $nin: ["booked", "sold"] }
        : availability;
  if (search) filter.$text = { $search: search };

  // Budget overlap: a property matches if its range overlaps the requested range at all.
  if (minBudget !== undefined) filter.budgetMax = { $gte: minBudget };
  if (maxBudget !== undefined)
    filter.budgetMin = { ...(filter.budgetMin || {}), $lte: maxBudget };

  const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

  const [properties, total] = await Promise.all([
    Property.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Property.countDocuments(filter),
  ]);

  return new ApiResponse(200, {
    properties,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/**
 * GET /api/properties/:id
 */
const getProperty = asyncHandler(async (req, res) => {
  const filter =
    req.user.role === "broker"
      ? { _id: req.params.id, isActive: true }
      : { _id: req.params.id, ...scopeToOwner(req) };
  const property = await Property.findOne(filter);
  if (!property) throw ApiError.notFound("Property not found");
  return new ApiResponse(200, { property }).send(res);
});

/**
 * PATCH /api/properties/:id
 */
const updateProperty = asyncHandler(async (req, res) => {
  const property = await Property.findOneAndUpdate(
    { _id: req.params.id, ...scopeToOwner(req) },
    { $set: req.body },
    { new: true, runValidators: true },
  );
  if (!property) throw ApiError.notFound("Property not found");
  return new ApiResponse(200, { property }, "Property updated").send(res);
});

/**
 * DELETE /api/properties/:id
 */
const deleteProperty = asyncHandler(async (req, res) => {
  const property = await Property.findOneAndDelete({
    _id: req.params.id,
    ...scopeToOwner(req),
  });
  if (!property) throw ApiError.notFound("Property not found");
  return new ApiResponse(200, null, "Property deleted").send(res);
});

/**
 * POST /api/properties/bulk-delete
 */
const bulkDeleteProperties = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const result = await Property.deleteMany({
    _id: { $in: ids },
    ...scopeToOwner(req),
  });
  return new ApiResponse(
    200,
    { deletedCount: result.deletedCount },
    "Properties deleted",
  ).send(res);
});

/**
 * GET /api/properties/export
 */
const exportProperties = asyncHandler(async (req, res) => {
  const { city, propertyType, bhk } = req.query;
  const filter = { ...scopeToOwner(req) };
  if (city) filter.city = new RegExp(`^${city}$`, "i");
  if (propertyType) filter.propertyType = new RegExp(`^${propertyType}$`, "i");
  if (bhk) filter.bhk = bhk;

  const properties = await Property.find(filter).sort({ createdAt: -1 }).lean();

  const fields = [
    "projectName",
    "builderName",
    "propertyType",
    "bhk",
    "location",
    "city",
    "budgetMin",
    "budgetMax",
    "sizeSqft",
    "amenities",
    "parking",
    "reraNumber",
    "nearbyMetro",
    "nearbySchool",
    "nearbyHospital",
    "mapsLink",
    "floor",
    "availability",
    "possession",
    "isActive",
    "createdAt",
  ];
  const parser = new CsvParser({ fields });
  const csv = parser.parse(
    properties.map((p) => ({ ...p, amenities: (p.amenities || []).join("|") })),
  );

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="properties-export-${Date.now()}.csv"`,
  );
  return res.send(csv);
});

module.exports = {
  previewImport,
  confirmImport,
  createProperty,
  uploadBrochureAndImages,
  listProperties,
  getProperty,
  updateProperty,
  deleteProperty,
  bulkDeleteProperties,
  exportProperties,
};
