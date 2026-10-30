const Settings = require('../../models/Settings');
const { sendDailySummary } = require('../reports/dailySummaryService');
const logger = require('../../utils/logger');

const TIMEZONE = 'Asia/Kolkata'; // same zone used for Google Calendar bookings elsewhere in this app
const CHECK_INTERVAL_MS = 60 * 1000; // check once a minute

function nowInTimezone() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`, // 'YYYY-MM-DD'
    hhmm: `${parts.hour}:${parts.minute}`, // 'HH:mm'
  };
}

/**
 * Runs every minute: single-tenant app, so there's at most one Settings
 * document — checks if the daily report is switched on, whether the
 * configured send time matches right now (to the minute), and that it
 * hasn't already been sent today — then sends it and stamps the date so it
 * doesn't fire again for the rest of the day.
 */
async function tick() {
  const { dateStr, hhmm } = nowInTimezone();

  const due = await Settings.find({
    dailyReportEnabled: true,
    dailyReportTime: hhmm,
    dailyReportPhone: { $nin: [null, ''] },
  }).select('+dailyReportLastSentDate');

  for (const settings of due) {
    if (settings.dailyReportLastSentDate === dateStr) continue; // already sent today

    try {
      await sendDailySummary({
        phone: settings.dailyReportPhone,
        timezone: TIMEZONE,
      });
      settings.dailyReportLastSentDate = dateStr;
      await settings.save();
    } catch (err) {
      logger.error('[reports] Failed to send daily summary', { error: err.message });
      // Deliberately NOT stamping dailyReportLastSentDate on failure, so the
      // next minute's tick retries it automatically within the same day.
    }
  }
}

let intervalHandle = null;

function startDailyReportScheduler() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tick().catch((err) => logger.error('[reports] Daily report scheduler tick failed', { error: err.message }));
  }, CHECK_INTERVAL_MS);
  logger.info(`[reports] Daily report scheduler started (checking every minute, timezone=${TIMEZONE})`);
}

function stopDailyReportScheduler() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { startDailyReportScheduler, stopDailyReportScheduler, tick };
