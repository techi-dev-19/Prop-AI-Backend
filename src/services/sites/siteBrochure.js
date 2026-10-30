const PropertySite = require('../../models/PropertySite');
const logger = require('../../utils/logger');

const keyFor = PropertySite.keyFor;

/** Find-or-create the site for a project name, and optionally add a brochure / photos. */
async function upsertSite({ ownerId, name, city = '', location = '', brochure = null, images = [] }) {
  const nameKey = keyFor(name);
  if (!nameKey) return null;
  const update = {
    $setOnInsert: { ownerId, name: String(name).trim(), nameKey },
  };
  const set = {};
  if (city) set.city = city;
  if (location) set.location = location;
  if (Object.keys(set).length) update.$set = set;
  const push = {};
  if (brochure?.url) push.brochures = { url: brochure.url, name: brochure.name || brochure.originalName || 'brochure.pdf', label: brochure.label || '', publicId: brochure.publicId || null, uploadedAt: new Date() };
  if (images.length) push.images = { $each: images };
  if (Object.keys(push).length) update.$push = push;
  return PropertySite.findOneAndUpdate({ ownerId, nameKey }, update, { upsert: true, new: true, setDefaultsOnInsert: true });
}

/**
 * Give a property the brochure of its own site (newest upload wins). Falls
 * back to the brochure saved on the unit row. Mutates and returns the object.
 */
async function attachSiteBrochure(property) {
  if (!property?.projectName) return property;
  try {
    const query = { nameKey: keyFor(property.projectName) };
    if (property.ownerId) query.ownerId = property.ownerId;
    const site = await PropertySite.findOne(query).lean();
    const latest = site?.brochures?.length ? site.brochures[site.brochures.length - 1] : null;
    if (latest?.url) {
      property.brochureUrl = latest.url;
      property.brochureName = latest.name || `${property.projectName}-brochure.pdf`;
    }
    if (site?.images?.length && !(property.images || []).length) property.images = site.images.slice(0, 10);
  } catch (err) {
    logger.warn('[sites] Could not load site brochure', { error: err.message, projectName: property.projectName });
  }
  return property;
}

module.exports = { keyFor, upsertSite, attachSiteBrochure };
