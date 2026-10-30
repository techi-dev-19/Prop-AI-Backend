/**
 * Gemini client — built to survive 503 / 429 / overload errors.
 *
 * Why the old client kept failing:
 *   1. It used ONE model only (gemini-2.0-flash — shut down by Google on
 *      1 June 2026). When that model was overloaded (503) every retry hit
 *      the same overloaded model.
 *   2. Only 2 short retries (1s, 2s) — far too short for a capacity spike.
 *   3. No request timeout — a hung request blocked the chat forever.
 *
 * What this client does instead:
 *   - MODEL FALLBACK CHAIN: primary model → fallbacks. If one model is
 *     overloaded we immediately try the next one instead of waiting.
 *   - Exponential backoff + jitter between rounds, honouring Retry-After.
 *   - Per-request timeout (default 30s) so a stuck request never blocks.
 *   - Short "cool-down" memory: a model that just returned 503/429 is
 *     skipped for COOLDOWN_MS so the next chat goes straight to a healthy
 *     model.
 *   - 404 / "model not found" → that model is skipped for 1 hour.
 *   - Broken / truncated JSON → automatically retried on the next model.
 *
 * Configure in .env:
 *   GEMINI_MODEL=gemini-3.8-flash
 *   GEMINI_FALLBACK_MODELS=gemini-3.5-flash-lite,gemini-3.6-flash,gemini-2.5-flash
 */
const logger = require("../../utils/logger");
const ApiError = require("../../utils/ApiError");

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const DEFAULT_PRIMARY = "gemini-3.8-flash";
const DEFAULT_FALLBACKS = [
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-2.5-flash",
];

// Models Google has already shut down — silently replaced so an old .env
// value never breaks the bot again.
const RETIRED_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-lite-001",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
]);

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function modelChain() {
  const primary = (process.env.GEMINI_MODEL || "").trim();
  const fallbacks = parseList(process.env.GEMINI_FALLBACK_MODELS);
  const chain = [
    primary && !RETIRED_MODELS.has(primary) ? primary : DEFAULT_PRIMARY,
    ...(fallbacks.length ? fallbacks : DEFAULT_FALLBACKS),
  ].filter((m) => !RETIRED_MODELS.has(m));
  return [...new Set(chain)];
}

const DEFAULT_MODEL = modelChain()[0];

const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048);
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 30000);
// How many times we walk the whole model chain before giving up.
const MAX_ROUNDS = Number(process.env.GEMINI_MAX_ROUNDS || 3);
const BASE_BACKOFF_MS = 1200;
const MAX_BACKOFF_MS = 8000;
const COOLDOWN_MS = 60 * 1000; // skip an overloaded model for 1 minute
const NOT_FOUND_COOLDOWN_MS = 60 * 60 * 1000; // skip a missing model for 1 hour

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** model -> timestamp until which it should be skipped */
const cooldowns = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(round, retryAfterMs) {
  if (retryAfterMs) return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** round);
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
}

function isCoolingDown(model) {
  const until = cooldowns.get(model);
  if (!until) return false;
  if (Date.now() > until) {
    cooldowns.delete(model);
    return false;
  }
  return true;
}

function coolDown(model, ms = COOLDOWN_MS) {
  cooldowns.set(model, Date.now() + ms);
}

function parseRetryAfter(response) {
  const header = response?.headers?.get?.("retry-after");
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function isGemini2x(model) {
  return /^gemini-2\./.test(model);
}

function buildBody({ model, systemInstruction, contents, responseSchema, temperature }) {
  const generationConfig = { maxOutputTokens: MAX_OUTPUT_TOKENS };

  // Sampling params are deprecated on the Gemini 3.6+ family — only send
  // temperature to older models so newer ones never reject the request.
  if (isGemini2x(model) && typeof temperature === "number") {
    generationConfig.temperature = temperature;
  }
  // 2.5 models "think" by default, which is slow and can eat the output
  // budget (truncated JSON). Chat replies don't need it.
  if (/^gemini-2\.5-flash/.test(model)) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  if (responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = responseSchema;
  }

  return {
    system_instruction: { parts: [{ text: systemInstruction || "" }] },
    contents,
    generationConfig,
  };
}

function toContents(history) {
  const turns = Array.isArray(history)
    ? history
        .filter(
          (t) =>
            t &&
            (t.role === "user" || t.role === "model") &&
            typeof t.text === "string" &&
            t.text.trim(),
        )
        .map((t) => ({ role: t.role, parts: [{ text: t.text }] }))
    : [];

  // Gemini requires the conversation to start with a user turn.
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length) turns.push({ role: "user", parts: [{ text: "Hi" }] });

  // Merge consecutive same-role turns (two quick customer messages etc.).
  const merged = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.parts[0].text += `\n${t.parts[0].text}`;
    else merged.push({ role: t.role, parts: [{ text: t.parts[0].text }] });
  }
  return merged;
}

/** Pulls a JSON object out of model text, even if wrapped in ``` fences. */
function parseJsonLoose(text) {
  if (!text) throw new Error("empty response");
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    /* fall through */
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start !== -1 && end > start) return JSON.parse(stripped.slice(start, end + 1));
  throw new Error("no JSON object found");
}

/**
 * One HTTP call to one model. Returns { ok, text, raw } or
 * { ok:false, retryable, status, retryAfterMs, message }.
 */
async function callModel({ apiKey, model, body }) {
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    return {
      ok: false,
      retryable: true,
      status: timedOut ? 408 : 0,
      message: timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err.message,
    };
  }

  const duration = Date.now() - startedAt;

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      retryable: RETRYABLE_STATUS.has(response.status),
      retryAfterMs: parseRetryAfter(response),
      message: errText.slice(0, 400),
      duration,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { ok: false, retryable: true, status: 200, message: "invalid JSON body from Gemini" };
  }

  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((p) => !p.thought)
    .map((p) => p?.text || "")
    .join("");

  if (!text) {
    return {
      ok: false,
      retryable: true,
      status: 200,
      message: `empty response (finishReason=${candidate?.finishReason || "?"}, block=${data?.promptFeedback?.blockReason || "none"})`,
    };
  }

  return { ok: true, text, raw: data, duration, finishReason: candidate?.finishReason };
}

/**
 * Core loop: walks the model chain for up to MAX_ROUNDS rounds.
 * `validate(text)` may throw to mark an answer unusable (e.g. bad JSON) —
 * that model is then treated like a soft failure and the next one is tried.
 */
async function runWithFallback({ apiKey, systemInstruction, history, responseSchema, temperature, validate }) {
  if (!apiKey) {
    throw ApiError.badRequest(
      "No Gemini API key configured — add one in Settings before enabling AI conversations",
    );
  }

  const contents = toContents(history);
  const chain = modelChain();
  let lastFailure = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Round 0 respects cool-downs; later rounds try everything again.
    const models = round === 0 ? chain.filter((m) => !isCoolingDown(m)) : chain;
    const toTry = models.length ? models : chain;
    let retryAfterHint = null;

    for (const model of toTry) {
      const body = buildBody({ model, systemInstruction, contents, responseSchema, temperature });
      const result = await callModel({ apiKey, model, body });

      if (result.ok) {
        try {
          const value = validate ? validate(result.text) : result.text;
          if (round > 0 || model !== chain[0]) {
            logger.info("[gemini] Recovered using fallback", { model, round: round + 1 });
          }
          return { value, text: result.text, raw: result.raw, model };
        } catch (err) {
          lastFailure = { model, status: "bad_output", message: err.message };
          logger.warn("[gemini] Unusable output, trying next model", {
            model,
            finishReason: result.finishReason,
            error: err.message,
          });
          continue;
        }
      }

      lastFailure = { model, ...result };

      if (result.status === 404) {
        logger.warn("[gemini] Model not available, skipping for 1h", { model });
        coolDown(model, NOT_FOUND_COOLDOWN_MS);
        continue;
      }
      if (result.status === 400 || result.status === 401 || result.status === 403) {
        // Bad key / permission / bad request. A 400 can be model specific
        // (unsupported param), so still try the next model, but don't loop.
        logger.error("[gemini] Non-retryable error", {
          model,
          status: result.status,
          body: result.message,
        });
        if (result.status !== 400) {
          throw ApiError.internal(`Gemini API error (${result.status}) — check the API key`);
        }
        continue;
      }

      logger.warn("[gemini] Temporary failure, switching model", {
        model,
        status: result.status,
        round: round + 1,
        error: String(result.message || "").slice(0, 160),
      });
      if (result.status === 503 || result.status === 429) coolDown(model);
      if (result.retryAfterMs) retryAfterHint = result.retryAfterMs;
    }

    if (round < MAX_ROUNDS - 1) {
      const delay = backoffDelay(round, retryAfterHint);
      logger.warn("[gemini] All models busy, backing off", { delayMs: delay, round: round + 1 });
      await sleep(delay);
    }
  }

  logger.error("[gemini] All models failed", lastFailure || {});
  const err = ApiError.internal(
    `Gemini unavailable after retries (${lastFailure?.status || "unknown"})`,
  );
  err.geminiUnavailable = true;
  throw err;
}

/** Plain text generation. */
async function generateContent({ apiKey, systemInstruction, history, responseSchema, temperature = 0.7 }) {
  const { text, raw, model } = await runWithFallback({
    apiKey,
    systemInstruction,
    history,
    responseSchema,
    temperature,
  });
  return { text, raw, model };
}

/** JSON-schema generation; parses the result and retries on broken JSON. */
async function generateStructured({ apiKey, systemInstruction, history, responseSchema, temperature = 0.7 }) {
  const { value, raw, model } = await runWithFallback({
    apiKey,
    systemInstruction,
    history,
    responseSchema,
    temperature,
    validate: (text) => {
      const parsed = parseJsonLoose(text);
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      return parsed;
    },
  });
  return { parsed: value, raw, model };
}

module.exports = {
  generateContent,
  generateStructured,
  parseJsonLoose,
  modelChain,
  DEFAULT_MODEL,
  // exported for tests
  _internal: { cooldowns, toContents, backoffDelay },
};
