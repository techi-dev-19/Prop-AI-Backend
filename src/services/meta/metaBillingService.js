const axios = require("axios");
const env = require("../../config/env");
const logger = require("../../utils/logger");

/**
 * Meta WhatsApp usage & approximate charges, from the WhatsApp Business
 * Account's `pricing_analytics` (Graph API). Meta marks these figures as
 * approximate; the final amount is on Meta's invoice. COST is not returned
 * for accounts billed on a Solution Partner's credit line (volume still is).
 */
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map(); // key -> { at, value }
const SERVICE_FREE_PER_NUMBER = 1000; // free service messages per business number per calendar month (from Oct 2026)
const IST_OFFSET_MIN = 330;

function istDateString(date) {
  return new Date(date.getTime() + IST_OFFSET_MIN * 60000)
    .toISOString()
    .slice(0, 10);
}

// Start of a calendar month in India time, as a Date.
function istMonthStart(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, 1) - IST_OFFSET_MIN * 60000);
}

function rangeFor(range) {
  const now = new Date();
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  if (range === "last_month")
    return {
      start: istMonthStart(y, m - 1),
      end: istMonthStart(y, m),
      label: "Pichhla mahina",
    };
  if (range === "30d")
    return {
      start: new Date(now.getTime() - 30 * 86400000),
      end: now,
      label: "Pichhle 30 din",
    };
  if (range === "7d")
    return {
      start: new Date(now.getTime() - 7 * 86400000),
      end: now,
      label: "Pichhle 7 din",
    };
  return { start: istMonthStart(y, m), end: now, label: "Is mahine" };
}

async function graphGet(path, params) {
  const url = `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${path}`;
  const response = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${env.metaWhatsapp.accessToken}` },
    timeout: 20000,
  });
  return response.data;
}

function pointsFrom(payload) {
  const block = payload?.pricing_analytics;
  const data = Array.isArray(block?.data) ? block.data : [];
  return data.flatMap((item) => item.data_points || []);
}

/**
 * Returns { configured, costAvailable, currency, period, totals, byCategory,
 * daily, serviceFreeTier, error? }.
 */
async function getMetaUsage({ range = "this_month" } = {}) {
  const { accessToken, businessAccountId } = env.metaWhatsapp;
  const period = rangeFor(range);
  const base = {
    configured: Boolean(accessToken && businessAccountId),
    period: {
      range,
      label: period.label,
      start: period.start,
      end: period.end,
    },
  };
  if (!base.configured) {
    return {
      ...base,
      error:
        "META_WHATSAPP_ACCESS_TOKEN aur META_WHATSAPP_BUSINESS_ACCOUNT_ID backend .env mein set karein.",
    };
  }

  const key = `${businessAccountId}:${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const startTs = Math.floor(period.start.getTime() / 1000);
  const endTs = Math.floor(period.end.getTime() / 1000);
  const analytics = `pricing_analytics.start(${startTs}).end(${endTs}).granularity(DAILY).metric_types(["COST","VOLUME"]).dimensions(["PRICING_CATEGORY","PRICING_TYPE","PHONE"])`;

  let payload;
  try {
    payload = await graphGet(businessAccountId, {
      fields: `currency,${analytics}`,
    });
  } catch (err) {
    const meta = err.response?.data?.error;
    logger.warn("[meta-billing] pricing_analytics request failed", {
      error: meta || err.message,
    });
    return {
      ...base,
      error: meta?.message
        ? `Meta: ${meta.message}`
        : "Meta se usage data nahi mila. Access token aur permissions check karein.",
    };
  }

  const points = pointsFrom(payload);
  const currency = payload?.currency || "INR";
  const costAvailable = points.some((p) => typeof p.cost === "number");

  const totals = { volume: 0, cost: 0, chargedVolume: 0, freeVolume: 0 };
  const categories = new Map();
  const daily = new Map();
  const servicePhones = new Set();
  let serviceVolume = 0;

  for (const p of points) {
    const volume = Number(p.volume) || 0;
    const cost = Number(p.cost) || 0;
    const category = String(p.pricing_category || "UNKNOWN").toUpperCase();
    const free =
      String(p.pricing_type || "REGULAR").toUpperCase() !== "REGULAR";
    totals.volume += volume;
    totals.cost += cost;
    if (free) totals.freeVolume += volume;
    else totals.chargedVolume += volume;

    if (!categories.has(category))
      categories.set(category, {
        category,
        volume: 0,
        cost: 0,
        chargedVolume: 0,
        freeVolume: 0,
      });
    const c = categories.get(category);
    c.volume += volume;
    c.cost += cost;
    if (free) c.freeVolume += volume;
    else c.chargedVolume += volume;

    const day = istDateString(new Date(Number(p.start) * 1000));
    if (!daily.has(day)) daily.set(day, { date: day, volume: 0, cost: 0 });
    const d = daily.get(day);
    d.volume += volume;
    d.cost += cost;

    if (category === "SERVICE") {
      serviceVolume += volume;
      if (p.phone_number) servicePhones.add(String(p.phone_number));
    }
  }

  const round = (n) => Math.round(n * 100) / 100;
  const byCategory = [...categories.values()]
    .map((c) => ({
      ...c,
      cost: round(c.cost),
      avgCost: c.chargedVolume
        ? Math.round((c.cost / c.chargedVolume) * 10000) / 10000
        : 0,
    }))
    .sort((a, b) => b.cost - a.cost || b.volume - a.volume);
  const numbers = Math.max(1, servicePhones.size);
  const value = {
    ...base,
    costAvailable,
    currency,
    totals: { ...totals, cost: round(totals.cost) },
    byCategory,
    daily: [...daily.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ ...d, cost: round(d.cost) })),
    // Only meaningful for a calendar month.
    serviceFreeTier:
      range === "this_month" || range === "last_month"
        ? {
            limit: SERVICE_FREE_PER_NUMBER * numbers,
            used: serviceVolume,
            remaining: Math.max(
              0,
              SERVICE_FREE_PER_NUMBER * numbers - serviceVolume,
            ),
            numbers,
          }
        : null,
    fetchedAt: new Date(),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { getMetaUsage, rangeFor };
