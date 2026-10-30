const { google } = require('googleapis');
const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Books site-visit meetings straight onto a real Google Calendar.
 *
 * Auth: a Service Account (no per-broker OAuth flow to build/maintain).
 * Setup:
 *   1. Create a Service Account in Google Cloud Console, enable the
 *      Calendar API, and generate a JSON key.
 *   2. Set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY (from that JSON key)
 *      in the environment. GOOGLE_PRIVATE_KEY needs its newlines escaped as
 *      \n when stored as a single-line env var — this module un-escapes them.
 *   3. Open the target Google Calendar's settings -> "Share with specific
 *      people" -> add the service account's email with "Make changes to
 *      events" permission, then set GOOGLE_CALENDAR_ID to that calendar's id
 *      (its address, e.g. yourteam@yourcompany.com, or "primary").
 */

let cachedClient = null;

function isConfigured() {
  return Boolean(env.googleCalendar.clientEmail && env.googleCalendar.privateKey);
}

function getCalendarClient() {
  if (!isConfigured()) return null;
  if (cachedClient) return cachedClient;

  const auth = new google.auth.JWT({
    email: env.googleCalendar.clientEmail,
    key: env.googleCalendar.privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  cachedClient = google.calendar({ version: 'v3', auth });
  return cachedClient;
}

/** Combines a "YYYY-MM-DD" date + "HH:mm" time into an ISO string in the configured timezone. */
function toStartEnd(date, time) {
  const start = new Date(`${date}T${time}:00`);
  const end = new Date(start.getTime() + env.googleCalendar.defaultDurationMin * 60_000);
  return { start, end };
}

/**
 * Creates a calendar event for a confirmed site visit.
 * Returns { eventId, eventLink } or null if Calendar isn't configured
 * (logs a warning in that case rather than throwing, so a missing Calendar
 * setup never blocks the WhatsApp conversation itself).
 */
async function createCalendarEvent({ summary, description, date, time, attendeeEmail }) {
  const calendar = getCalendarClient();
  if (!calendar) {
    logger.warn('[calendar] Google Calendar is not configured (GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY) — skipping event creation');
    return null;
  }

  const { start, end } = toStartEnd(date, time);

  const requestBody = {
    summary,
    description,
    start: { dateTime: start.toISOString(), timeZone: env.googleCalendar.timezone },
    end: { dateTime: end.toISOString(), timeZone: env.googleCalendar.timezone },
  };
  if (attendeeEmail) requestBody.attendees = [{ email: attendeeEmail }];

  const { data } = await calendar.events.insert({
    calendarId: env.googleCalendar.calendarId,
    requestBody,
  });

  return { eventId: data.id, eventLink: data.htmlLink };
}

/** Updates an existing event's date/time (used when a broker reschedules a site visit). */
async function updateCalendarEvent({ eventId, date, time }) {
  const calendar = getCalendarClient();
  if (!calendar || !eventId) return null;

  const { start, end } = toStartEnd(date, time);

  const { data } = await calendar.events.patch({
    calendarId: env.googleCalendar.calendarId,
    eventId,
    requestBody: {
      start: { dateTime: start.toISOString(), timeZone: env.googleCalendar.timezone },
      end: { dateTime: end.toISOString(), timeZone: env.googleCalendar.timezone },
    },
  });

  return { eventId: data.id, eventLink: data.htmlLink };
}

/** Deletes/cancels a calendar event (used when a site visit is cancelled). */
async function deleteCalendarEvent(eventId) {
  const calendar = getCalendarClient();
  if (!calendar || !eventId) return;

  try {
    await calendar.events.delete({ calendarId: env.googleCalendar.calendarId, eventId });
  } catch (err) {
    // Already deleted / not found is fine to ignore; anything else, log it.
    if (err?.code !== 404 && err?.code !== 410) {
      logger.error('[calendar] Failed to delete Google Calendar event', { error: err.message, eventId });
    }
  }
}

module.exports = { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, isConfigured };
