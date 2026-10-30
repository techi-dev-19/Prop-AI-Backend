const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const EmailTemplate = require("../models/EmailTemplate");

const ownerFilter = (req) => ({ ownerId: req.user.id });

const list = asyncHandler(async (req, res) => {
  const templates = await EmailTemplate.find(ownerFilter(req)).sort({ updatedAt: -1 }).lean();
  return new ApiResponse(200, { templates }, "Email templates loaded").send(res);
});

const create = asyncHandler(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const subject = String(req.body?.subject || "").trim();
  const body = String(req.body?.body || "").trim();
  const category = String(req.body?.category || "marketing").trim();
  const imageUrl = String(req.body?.imageUrl || "").trim();
  if (name.length < 2 || name.length > 100) throw ApiError.badRequest("Template name 2–100 characters ka hona chahiye.");
  if (!subject || subject.length > 200) throw ApiError.badRequest("Subject required hai (maximum 200 characters).");
  if (!body || body.length > 5000) throw ApiError.badRequest("Email body required hai (maximum 5,000 characters).");
  if (!["marketing", "follow_up", "property_update", "general"].includes(category)) throw ApiError.badRequest("Invalid template category.");
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw ApiError.badRequest("Image URL must be HTTPS.");
  try {
    const template = await EmailTemplate.create({ ownerId: req.user.id, name, subject, body, category, imageUrl });
    return new ApiResponse(201, { template }, "Email template saved").send(res);
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict ? ApiError.conflict("Is naam ka template pehle se hai.") : ApiError.badRequest("Is naam ka template pehle se hai.");
    throw err;
  }
});

const update = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.badRequest("Invalid template id");
  const fields = {};
  for (const key of ["name", "subject", "body", "category", "imageUrl"]) if (req.body?.[key] !== undefined) fields[key] = typeof req.body[key] === "string" ? req.body[key].trim() : req.body[key];
  if (fields.name !== undefined && (fields.name.length < 2 || fields.name.length > 100)) throw ApiError.badRequest("Template name 2–100 characters ka hona chahiye.");
  if (fields.subject !== undefined && (!fields.subject || fields.subject.length > 200)) throw ApiError.badRequest("Subject required hai (maximum 200 characters).");
  if (fields.body !== undefined && (!fields.body || fields.body.length > 5000)) throw ApiError.badRequest("Email body required hai (maximum 5,000 characters).");
  if (fields.category !== undefined && !["marketing", "follow_up", "property_update", "general"].includes(fields.category)) throw ApiError.badRequest("Invalid template category.");
  if (fields.imageUrl !== undefined && fields.imageUrl && !/^https:\/\//i.test(fields.imageUrl)) throw ApiError.badRequest("Image URL must be HTTPS.");
  try {
    const template = await EmailTemplate.findOneAndUpdate({ _id: req.params.id, ...ownerFilter(req) }, { $set: fields }, { new: true, runValidators: true }).lean();
    if (!template) throw ApiError.notFound("Email template not found");
    return new ApiResponse(200, { template }, "Email template updated").send(res);
  } catch (err) {
    if (err?.code === 11000) throw ApiError.badRequest("Is naam ka template pehle se hai.");
    throw err;
  }
});

const remove = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.badRequest("Invalid template id");
  const result = await EmailTemplate.deleteOne({ _id: req.params.id, ...ownerFilter(req) });
  if (!result.deletedCount) throw ApiError.notFound("Email template not found");
  return new ApiResponse(200, { deleted: true }, "Email template deleted").send(res);
});

module.exports = { list, create, update, remove };
