const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const PropertySite = require('../models/PropertySite');
const Property = require('../models/Property');
const { uploadBufferToCloudinary } = require('../services/cloudinaryUpload');
const { upsertSite, keyFor } = require('../services/sites/siteBrochure');

function scopeOwnerId(req) {
  if (req.user.role === 'admin' && req.query.ownerId) return req.query.ownerId;
  return req.user.id;
}

/**
 * GET /api/sites — every site with its brochures plus unit counts from the
 * Properties sheet. Projects that exist only as sheet rows are listed too,
 * so a brochure can be added to them in one click.
 */
const listSites = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const [sites, units] = await Promise.all([
    PropertySite.find({ ownerId }).sort({ name: 1 }).lean(),
    Property.find({ ownerId }).select('projectName city location availability brochureUrl brochureName').lean(),
  ]);
  const byKey = new Map(sites.map((site) => [site.nameKey, { ...site, units: 0, available: 0, legacyBrochure: null }]));
  for (const unit of units) {
    const key = keyFor(unit.projectName);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { _id: null, name: unit.projectName, nameKey: key, city: unit.city || '', location: unit.location || '', brochures: [], images: [], units: 0, available: 0, legacyBrochure: null });
    const site = byKey.get(key);
    site.units += 1;
    if (!['booked', 'sold'].includes(unit.availability)) site.available += 1;
    if (!site.city && unit.city) site.city = unit.city;
    if (!site.location && unit.location) site.location = unit.location;
    // Brochure saved on a unit row before sites existed: show it so it is not lost.
    if (unit.brochureUrl && !site.legacyBrochure) site.legacyBrochure = { url: unit.brochureUrl, name: unit.brochureName || 'brochure.pdf' };
  }
  const list = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  return new ApiResponse(200, { sites: list }).send(res);
});

/** POST /api/sites/brochure — multipart: siteName, label?, city?, location?, brochure (PDF), images[] */
const uploadSiteBrochure = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const siteName = String(req.body.siteName || '').trim();
  if (!siteName) throw ApiError.badRequest('Site / project ka naam likhein.');
  const brochureFile = req.files?.brochure?.[0];
  const imageFiles = req.files?.images || [];
  if (!brochureFile && !imageFiles.length) throw ApiError.badRequest('Brochure PDF ya photos chunein.');

  let brochure = null;
  if (brochureFile) {
    const result = await uploadBufferToCloudinary(brochureFile.buffer, { folder: 'properties/brochures', resourceType: 'raw' });
    brochure = { url: result.secure_url, publicId: result.public_id, name: brochureFile.originalname, label: String(req.body.label || '').trim().slice(0, 80) };
  }
  const images = [];
  for (const file of imageFiles) {
    const result = await uploadBufferToCloudinary(file.buffer, { folder: 'properties/images', resourceType: 'image' });
    images.push(result.secure_url);
  }
  const site = await upsertSite({ ownerId, name: siteName, city: String(req.body.city || '').trim(), location: String(req.body.location || '').trim(), brochure, images });
  return new ApiResponse(201, { site }, `${site.name} ke liye ${brochure ? 'brochure' : 'photos'} save ho gaye`).send(res);
});

/** PATCH /api/sites/:id — rename / city / location / description / maps link. */
const updateSite = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const site = await PropertySite.findOne({ _id: req.params.id, ownerId });
  if (!site) throw ApiError.notFound('Site not found');
  const { name, city, location, description, mapsLink } = req.body;
  if (name && keyFor(name) !== site.nameKey) {
    const nameKey = keyFor(name);
    if (await PropertySite.exists({ ownerId, nameKey, _id: { $ne: site._id } })) throw ApiError.conflict('Is naam ki site pehle se hai.');
    // Keep the sheet rows linked to the renamed site.
    await Property.updateMany({ ownerId, projectName: new RegExp(`^\\s*${site.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }, { $set: { projectName: name.trim() } });
    site.name = name.trim();
    site.nameKey = nameKey;
  }
  if (city !== undefined) site.city = city;
  if (location !== undefined) site.location = location;
  if (description !== undefined) site.description = description;
  if (mapsLink !== undefined) site.mapsLink = mapsLink;
  await site.save();
  return new ApiResponse(200, { site }, 'Site updated').send(res);
});

/** DELETE /api/sites/:id/brochures/:brochureId */
const removeBrochure = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const site = await PropertySite.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $pull: { brochures: { _id: req.params.brochureId } } },
    { new: true },
  );
  if (!site) throw ApiError.notFound('Site not found');
  return new ApiResponse(200, { site }, 'Brochure hata diya').send(res);
});

/** DELETE /api/sites/:id/images — body { url } */
const removeImage = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const site = await PropertySite.findOneAndUpdate({ _id: req.params.id, ownerId }, { $pull: { images: req.body.url } }, { new: true });
  if (!site) throw ApiError.notFound('Site not found');
  return new ApiResponse(200, { site }, 'Photo hata di').send(res);
});

module.exports = { listSites, uploadSiteBrochure, updateSite, removeBrochure, removeImage };
