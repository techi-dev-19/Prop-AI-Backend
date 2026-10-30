// const Settings = require('../../models/Settings');
// const { encrypt, decrypt } = require('../../utils/crypto');

// /** Every organization gets a lazily-created Settings doc on first access. */
// async function getOrCreateSettings(organizationId) {
//   let settings = await Settings.findOne({ organizationId });
//   if (!settings) {
//     settings = await Settings.create({ organizationId });
//   }
//   return settings;
// }

// /** Public-safe settings (never exposes the raw Gemini key, only whether one is set). */
// async function getPublicSettings(organizationId) {
//   const settings = await getOrCreateSettings(organizationId);
//   const withKey = await Settings.findOne({ organizationId }).select('+geminiApiKeyEncrypted');

//   return {
//     ...settings.toObject(),
//     geminiApiKeyEncrypted: undefined,
//     geminiKeyConfigured: !!withKey?.geminiApiKeyEncrypted,
//   };
// }

// async function updateSettings(organizationId, updates) {
//   const settings = await getOrCreateSettings(organizationId);

//   const { geminiApiKey, ...rest } = updates;
//   Object.assign(settings, rest);

//   if (geminiApiKey !== undefined) {
//     settings.geminiApiKeyEncrypted = geminiApiKey ? encrypt(geminiApiKey) : null;
//   }

//   await settings.save();
//   return getPublicSettings(organizationId);
// }

// /**
//  * Returns the org's Gemini key, falling back to the platform-wide
//  * GEMINI_API_KEY env var so the product works out-of-the-box before a
//  * broker/builder has configured their own key in Settings.
//  */
// async function getGeminiKey(organizationId) {
//   const settings = await Settings.findOne({ organizationId }).select('+geminiApiKeyEncrypted');
//   const orgKey = settings ? decrypt(settings.geminiApiKeyEncrypted) : null;
//   return orgKey || process.env.GEMINI_API_KEY || null;
// }

// module.exports = { getOrCreateSettings, getPublicSettings, updateSettings, getGeminiKey };


const Settings = require('../../models/Settings');
const { encrypt, decrypt } = require('../../utils/crypto');

/**
 * Single-tenant deployment — there is exactly ONE Settings document for the
 * whole app (no organizationId scoping). Lazily created on first access.
 */
async function getOrCreateSettings() {
  let settings = await Settings.findOne({});
  if (!settings) {
    settings = await Settings.create({});
  }
  return settings;
}

/** Public-safe settings (never exposes the raw Gemini key, only whether one is set). */
async function getPublicSettings() {
  const settings = await getOrCreateSettings();
  const withKey = await Settings.findOne({}).select('+geminiApiKeyEncrypted');

  return {
    ...settings.toObject(),
    geminiApiKeyEncrypted: undefined,
    geminiKeyConfigured: !!withKey?.geminiApiKeyEncrypted,
  };
}

async function updateSettings(updates) {
  const settings = await getOrCreateSettings();

  const { geminiApiKey, ...rest } = updates;
  Object.assign(settings, rest);

  if (geminiApiKey !== undefined) {
    settings.geminiApiKeyEncrypted = geminiApiKey ? encrypt(geminiApiKey) : null;
  }

  await settings.save();
  return getPublicSettings();
}

/**
 * Returns the configured Gemini key, falling back to the platform-wide
 * GEMINI_API_KEY env var so the product works out-of-the-box before the
 * broker/builder has configured their own key in Settings.
 */
async function getGeminiKey() {
  const settings = await Settings.findOne({}).select('+geminiApiKeyEncrypted');
  const configuredKey = settings ? decrypt(settings.geminiApiKeyEncrypted) : null;
  return configuredKey || process.env.GEMINI_API_KEY || null;
}

module.exports = { getOrCreateSettings, getPublicSettings, updateSettings, getGeminiKey };
