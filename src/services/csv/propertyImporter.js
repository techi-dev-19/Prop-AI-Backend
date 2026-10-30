const Papa = require('papaparse');
const Property = require('../../models/Property');

const HEADER_ALIASES = {
  projectName: ['projectname', 'project', 'propertyname'],
  builderName: ['buildername', 'builder', 'developer', 'developername'],
  propertyType: ['propertytype', 'type'],
  bhk: ['bhk', 'bedrooms', 'configuration'],
  location: ['location', 'area', 'locality'],
  city: ['city'],
  budget: ['budget', 'price'],
  budgetMin: ['budgetmin', 'minimumbudget', 'minbudget', 'pricefrom', 'minprice'],
  budgetMax: ['budgetmax', 'maximumbudget', 'maxbudget', 'priceto', 'maxprice'],
  sizeSqft: ['size', 'sizesqft', 'areasqft', 'carpetarea', 'superarea', 'sqft'],
  amenities: ['amenities', 'facilities'],
  parking: ['parking'],
  reraNumber: ['reranumber', 'rera'],
  nearbyMetro: ['nearbymetro', 'metro'],
  nearbySchool: ['nearbyschool', 'school'],
  nearbyHospital: ['nearbyhospital', 'hospital'],
  mapsLink: ['googlemapslink', 'mapslink', 'maps'],
  description: ['description', 'desc'],
  images: ['images', 'image', 'photos', 'imageurls'],
  floor: ['floor', 'floorno', 'floornumber'],
  availability: ['status', 'availability', 'available'],
  possession: ['possession', 'possessiondate', 'handover'],
};

function parseAvailability(value) {
  const v = String(value || '').trim().toLowerCase();
  if (/sold/.test(v)) return 'sold';
  if (/book|hold|reserved/.test(v)) return 'booked';
  return 'available';
}

function normalizeKey(key) {
  // "Price from (₹)", "Area (sq ft)" → pricefrom, areasqft
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildHeaderMap(rawHeaders) {
  const map = {};
  const normalizedHeaders = rawHeaders.map((h) => ({ raw: h, norm: normalizeKey(h) }));
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const match = normalizedHeaders.find((h) => aliases.includes(h.norm));
    if (match) map[match.raw] = field;
  }
  return map;
}

/** Same budget-token parsing style as leads: "50L", "1.2 Cr", "5000000". */
function parseBudgetToken(token) {
  if (token === undefined || token === null || token === '') return null;
  const str = String(token).trim().toLowerCase();
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  if (Number.isNaN(num)) return null;
  if (str.includes('cr')) return Math.round(num * 10000000);
  if (str.includes('l')) return Math.round(num * 100000);
  return Math.round(num);
}

function parseBudgetRange(budgetStr) {
  if (!budgetStr) return { budgetMin: null, budgetMax: null };
  const parts = String(budgetStr).split(/-|to/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    return { budgetMin: parseBudgetToken(parts[0]), budgetMax: parseBudgetToken(parts[1]) };
  }
  const single = parseBudgetToken(parts[0]);
  return { budgetMin: single, budgetMax: single };
}

/** Splits a delimited list field on comma or pipe, trims, drops empties. */
function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(/[|,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseBoolean(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['yes', 'y', 'true', '1', 'available'].includes(v);
}

function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf-8');
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (result.errors?.length) {
    const firstError = result.errors[0];
    throw new Error(`CSV parse error at row ${firstError.row + 1}: ${firstError.message}`);
  }

  const rawHeaders = result.meta.fields || [];
  const headerMap = buildHeaderMap(rawHeaders);

  if (!Object.values(headerMap).includes('projectName')) {
    throw new Error('CSV must include a "Project Name" column');
  }

  const rows = result.data.map((rawRow, idx) => {
    const normalized = { _rowNumber: idx + 2 };
    for (const [rawHeader, field] of Object.entries(headerMap)) {
      normalized[field] = (rawRow[rawHeader] ?? '').toString().trim();
    }

    const { budgetMin, budgetMax } = normalized.budgetMin || normalized.budgetMax
      ? { budgetMin: parseBudgetToken(normalized.budgetMin), budgetMax: parseBudgetToken(normalized.budgetMax) }
      : parseBudgetRange(normalized.budget);

    return {
      rowNumber: normalized._rowNumber,
      projectName: normalized.projectName || '',
      builderName: normalized.builderName || '',
      propertyType: normalized.propertyType || '',
      bhk: normalized.bhk || '',
      location: normalized.location || '',
      city: normalized.city || '',
      budgetMin,
      budgetMax,
      sizeSqft: normalized.sizeSqft ? parseFloat(normalized.sizeSqft.replace(/[^0-9.]/g, '')) : null,
      amenities: splitList(normalized.amenities),
      parking: parseBoolean(normalized.parking),
      reraNumber: normalized.reraNumber || '',
      nearbyMetro: normalized.nearbyMetro || '',
      nearbySchool: normalized.nearbySchool || '',
      nearbyHospital: normalized.nearbyHospital || '',
      mapsLink: normalized.mapsLink || '',
      description: normalized.description || '',
      images: splitList(normalized.images),
      floor: normalized.floor || '',
      availability: parseAvailability(normalized.availability),
      possession: normalized.possession || '',
    };
  });

  return rows;
}

function validateRow(row) {
  const errors = [];
  if (!row.projectName) errors.push('Project Name is required');
  if (
    row.budgetMin !== null &&
    row.budgetMax !== null &&
    row.budgetMin !== undefined &&
    row.budgetMax !== undefined &&
    row.budgetMin > row.budgetMax
  ) {
    errors.push('Minimum budget cannot be greater than maximum budget');
  }
  if (row.sizeSqft !== null && row.sizeSqft !== undefined && Number.isNaN(row.sizeSqft)) {
    errors.push('Invalid size value');
  }
  if (row.mapsLink && !/^https?:\/\//i.test(row.mapsLink)) {
    errors.push('Google Maps link should start with http:// or https://');
  }
  return errors;
}

/**
 * Flags soft duplicates: same (projectName + location) already exists for this
 * builder, or repeated within the file. Unlike leads, this is informational —
 * builders legitimately re-list phases/towers of the same project — so the
 * caller decides whether to skip or import anyway.
 */
async function analyzeRows(ownerId, rows) {
  const existingProjects = await Property.find(
    { ownerId },
    { projectName: 1, location: 1 }
  ).lean();
  const existingKeySet = new Set(
    existingProjects.map((p) => `${p.projectName.toLowerCase()}|${(p.location || '').toLowerCase()}`)
  );

  const seenInFile = new Set();
  const analyzed = rows.map((row) => {
    const errors = validateRow(row);
    const key = `${row.projectName.toLowerCase()}|${(row.location || '').toLowerCase()}`;

    let isDuplicate = false;
    let duplicateReason = null;
    if (row.projectName) {
      if (existingKeySet.has(key)) {
        isDuplicate = true;
        duplicateReason = 'A property with this project name + location already exists';
      } else if (seenInFile.has(key)) {
        isDuplicate = true;
        duplicateReason = 'Duplicate project name + location within this file';
      }
      seenInFile.add(key);
    }

    let status = 'valid';
    if (errors.length) status = 'invalid';
    else if (isDuplicate) status = 'duplicate';

    return { ...row, errors, isDuplicate, duplicateReason, status };
  });

  const summary = {
    total: analyzed.length,
    valid: analyzed.filter((r) => r.status === 'valid').length,
    invalid: analyzed.filter((r) => r.status === 'invalid').length,
    duplicate: analyzed.filter((r) => r.status === 'duplicate').length,
  };

  return { rows: analyzed, summary };
}

module.exports = { parseCsvBuffer, validateRow, analyzeRows };
