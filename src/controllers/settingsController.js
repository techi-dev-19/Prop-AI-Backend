const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const settingsService = require('../services/settings/settingsService');
const { sendDailySummary } = require('../services/reports/dailySummaryService');

/** GET /api/settings */
const getSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.getPublicSettings();
  return new ApiResponse(200, { settings }).send(res);
});

/**
 * PATCH /api/settings
 * Accepts any subset of: companyName, logoUrl, geminiApiKey, businessHours,
 * workingDays, greetingMessage, openingText, aiPaused, autoReplyEnabled.
 */
const updateSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings(req.body);
  return new ApiResponse(200, { settings }, 'Settings updated').send(res);
});

/** POST /api/settings/ai/pause — quick toggle used by the WhatsApp/Settings page "Pause AI" button. */
const pauseAI = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings({ aiPaused: true });
  return new ApiResponse(200, { settings }, 'AI paused across all conversations').send(res);
});

/** POST /api/settings/ai/resume */
const resumeAI = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings({ aiPaused: false });
  return new ApiResponse(200, { settings }, 'AI resumed').send(res);
});

/**
 * POST /api/settings/daily-report/send-now
 * Manual trigger to test the daily WhatsApp summary immediately instead of
 * waiting for the scheduled time — uses whatever dailyReportPhone is
 * currently saved in Settings.
 */
const sendDailyReportNow = asyncHandler(async (req, res) => {
  const settings = await settingsService.getOrCreateSettings();
  if (!settings.dailyReportPhone) {
    throw ApiError.badRequest('Set dailyReportPhone in Settings first (PATCH /api/settings)');
  }

  const result = await sendDailySummary({
    phone: settings.dailyReportPhone,
    timezone: 'Asia/Kolkata',
  });

  return new ApiResponse(200, result, 'Daily summary sent').send(res);
});

module.exports = { getSettings, updateSettings, pauseAI, resumeAI, sendDailyReportNow };
