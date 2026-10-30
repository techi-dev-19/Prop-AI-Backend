const Lead = require('../../models/Lead');
const Message = require('../../models/Message');
const metaWhatsappClient = require('../whatsapp/metaWhatsappClient');
const logger = require('../../utils/logger');

// A lead counts as "interested" for the report if its status has moved
// past a cold first-touch. Tweak this list if you want a stricter/looser
// definition (e.g. add 'contacted', or restrict to just 'hot').
const INTERESTED_STATUSES = ['qualified', 'hot', 'warm', 'site_visit'];

/**
 * Returns the start/end of "today" as real Date objects, computed in the
 * given IANA timezone (not the server's local time — a server running in
 * UTC would otherwise cut the day off at the wrong hour).
 */
function getTodayRangeInTimezone(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;

  // Approximate the timezone's midnight as a UTC instant. Good enough for a
  // once-a-day report (no DST edge cases worth handling here).
  const offsetMinutes = getTimezoneOffsetMinutes(timezone, now);
  const startUtc = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
  startUtc.setMinutes(startUtc.getMinutes() - offsetMinutes);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);

  return { start: startUtc, end: endUtc, dateLabel: `${d}/${m}/${y}` };
}

function getTimezoneOffsetMinutes(timezone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asIfUtc - date.getTime()) / 60000;
}

/**
 * Builds the plain-text WhatsApp report body: how many leads were messaged
 * today, and which of them look interested (status-wise), with name+phone.
 */
async function buildDailySummaryText({ timezone = 'Asia/Kolkata' }) {
  const { start, end, dateLabel } = getTodayRangeInTimezone(timezone);

  // Every lead (single-tenant app — no org scoping) that had ANY message
  // (inbound or outbound/AI) today.
  const activeLeadIds = await Message.distinct('leadId', {
    timestamp: { $gte: start, $lt: end },
  });

  const activeLeads = await Lead.find({ _id: { $in: activeLeadIds } })
    .select('name phone status leadScore city')
    .lean();

  const interested = activeLeads.filter((l) => INTERESTED_STATUSES.includes(l.status));

  const lines = [];
  lines.push(`*Daily WhatsApp Leads Summary — ${dateLabel}*`);
  lines.push('');
  lines.push(`Total leads messaged today: *${activeLeads.length}*`);
  lines.push(`Interested leads: *${interested.length}*`);
  lines.push('');

  if (interested.length) {
    lines.push('*Interested leads (name — phone — status):*');
    interested
      .sort((a, b) => (b.leadScore || 0) - (a.leadScore || 0))
      .forEach((l, i) => {
        lines.push(`${i + 1}. ${l.name || 'Unnamed'} — ${l.phone} — ${l.status}${l.city ? ` — ${l.city}` : ''}`);
      });
  } else {
    lines.push('No leads moved to an interested status today.');
  }

  return lines.join('\n');
}

/**
 * Sends the built report to the configured WhatsApp number.
 *
 * NOTE: this is a plain free-text send, so — same as any other free-text
 * message on the Meta Cloud API — it only works if this number has messaged
 * the connected WhatsApp business number within the last 24 hours (e.g. the
 * broker just needs to say "hi" to their own bot number once a day, or you
 * can instead build a small daily-report TEMPLATE and swap this to
 * sendTemplateMessage() if that's inconvenient).
 */
async function sendDailySummary({ phone, timezone }) {
  const text = await buildDailySummaryText({ timezone });
  try {
    const { messageId } = await metaWhatsappClient.sendTextMessage({ phone, text });
    logger.info(`[reports] Daily summary sent to ${phone} (messageId=${messageId})`);
    return { text, messageId };
  } catch (err) {
    if (err.code === 'WHATSAPP_24H_WINDOW_CLOSED') {
      logger.warn(
        `[reports] Daily summary NOT sent to ${phone} — this number hasn't messaged the WhatsApp business number in the last 24h. Either message it once from that number, or set up a dedicated daily-report template.`
      );
    }
    throw err;
  }
}

module.exports = { buildDailySummaryText, sendDailySummary };
