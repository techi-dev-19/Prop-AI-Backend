/**
 * Phone / email normalisation shared by every lead-import path
 * (CSV, Excel, pasted text, campaign bulk upload).
 *
 * Canonical phone shape: bare digits with country code, e.g. "919810044003".
 *
 * Handles the messy things real sheets contain:
 *  - "+91 98100-44003", "(091) 98100 44003", "0098100...", "09810044003"
 *  - Excel artefacts: "9810044003.0", "9.810044003E+9", leading apostrophe
 *  - several numbers in one cell: "98100 44003 / 98100 44004", "a, b", "a or b"
 *  - letters / labels / extensions: "Mob: 98100 44003 (office) ext 12"
 *  - Devanagari / Arabic-Indic / full-width digits
 *  - wrong length (10-digit with extra/missing digit) -> rejected with a reason,
 *    never silently stored as a wrong number.
 */

const DEFAULT_CC = String(
  process.env.META_WHATSAPP_DEFAULT_COUNTRY_CODE || "91",
);

// Calling codes accepted for numbers written WITHOUT a leading "+" / "00".
// (With an explicit "+" any 8-15 digit number is accepted.)
const KNOWN_CC = [
  "1",
  "7",
  "20",
  "27",
  "31",
  "32",
  "33",
  "34",
  "39",
  "41",
  "44",
  "49",
  "52",
  "55",
  "60",
  "61",
  "62",
  "63",
  "64",
  "65",
  "66",
  "81",
  "82",
  "84",
  "86",
  "90",
  "92",
  "93",
  "94",
  "95",
  "98",
  "212",
  "213",
  "234",
  "249",
  "254",
  "255",
  "256",
  "351",
  "353",
  "358",
  "880",
  "960",
  "961",
  "962",
  "964",
  "965",
  "966",
  "968",
  "971",
  "972",
  "973",
  "974",
  "975",
  "977",
];

function normalizeDigits(input) {
  return String(input ?? "")
    .normalize("NFKC") // full-width digits -> ascii
    .replace(/[\u0966-\u096F]/g, (c) => String(c.charCodeAt(0) - 0x0966)) // Devanagari
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660)) // Arabic-Indic
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0)) // Persian
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "") // invisible chars
    .replace(/\u00A0/g, " ");
}

const SCI_RE = /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i;

/**
 * Excel often turns long numbers into "9.81004E+9" (precision already lost) or
 * "9810044003.0". Returns { text, lossy }.
 */
function expandNumericArtefacts(text) {
  const t = text.trim();
  if (SCI_RE.test(t)) {
    const mantissaDigits = t
      .split(/e/i)[0]
      .replace(/[^\d]/g, "")
      .replace(/0+$/, "");
    const n = Number(t);
    if (!Number.isFinite(n)) return { text: t, lossy: true };
    return {
      text: BigInt(Math.round(n)).toString(),
      // A real 10-digit mobile needs >= 10 significant digits in the mantissa.
      lossy: mantissaDigits.length < 10,
    };
  }
  // "9810044003.0" / "9810044003.00" (float artefact from pandas / Excel)
  const dec = t.match(/^(\d{8,})\.\d*$/);
  if (dec) return { text: dec[1], lossy: false };
  return { text: t, lossy: false };
}

function digitCount(s) {
  return (String(s).match(/\d/g) || []).length;
}

/** Split one cell into candidate number strings. */
function splitCandidates(text) {
  const parts = text
    .split(/[,;/|\n\r]+|\s+(?:or|and|aur|&)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);

  const out = [];
  for (const part of parts) {
    // "+91 98100 44003 +91 98100 44004" -> split before every "+"
    const plusSplit = part.split(/\s+(?=\+)/).filter(Boolean);
    for (const piece of plusSplit) {
      if (digitCount(piece) <= 15) {
        out.push(piece);
        continue;
      }
      // Several numbers pasted with only spaces between them.
      let current = "";
      for (const token of piece.split(/\s+/)) {
        if (
          current &&
          digitCount(current) >= 10 &&
          digitCount(current) + digitCount(token) > 13
        ) {
          out.push(current);
          current = token;
        } else {
          current = current ? `${current} ${token}` : token;
        }
      }
      if (current) out.push(current);
    }
  }
  return out;
}

function isIndianMobile(ten) {
  return /^[6-9]\d{9}$/.test(ten);
}

function isDummy(digits) {
  const local = digits.slice(-10);
  return (
    /^(\d)\1{9}$/.test(local) ||
    local === "1234567890" ||
    local === "0123456789"
  );
}

/** Normalise ONE candidate. Returns { phone } or { error }. */
function normalizeCandidate(candidate, cc) {
  let t = candidate.trim();
  // "(0)" trunk prefix inside +91 (0) 98100...
  t = t.replace(/\(\s*0\s*\)/g, " ");
  // extensions: "ext 12", "x12"
  t = t.replace(/\s*(?:ext|extn|extension|x)\.?\s*\d{1,6}\s*$/i, "");
  // bracketed notes: "(office)"
  t = t.replace(/\([^)]*[a-z][^)]*\)/gi, " ");
  // labels like "Mob:", "WhatsApp -"
  t = t.replace(/[a-z]+/gi, " ").trim();

  const hasPlus = /^\+/.test(t) || /^\(?\+/.test(t);
  let digits = t.replace(/\D/g, "");
  if (!digits) return { error: "No digits in phone value" };

  let international = hasPlus;
  if (!international && digits.startsWith("00")) {
    digits = digits.slice(2);
    international = true;
  }

  const bad = (reason) => ({ error: `${reason} (${digits})` });

  if (cc === "91" || international) {
    // ---------- India ----------
    if (!international) {
      // trunk "0" before a 10-digit number: 09810044003 / 091 9810044003
      if (digits.length === 11 && digits[0] === "0") digits = digits.slice(1);
      else if (digits.length === 13 && digits.startsWith("091"))
        digits = digits.slice(1);
    }

    if (digits.length === 10) {
      if (cc !== "91") return { phone: `${cc}${digits}` };
      if (!isIndianMobile(digits)) {
        return bad("Not a valid Indian mobile number (must start with 6-9)");
      }
      if (isDummy(digits)) return bad("Dummy / placeholder number");
      return { phone: `91${digits}` };
    }

    if (digits.startsWith("91") && (international || digits.length >= 11)) {
      let rest = digits.slice(2);
      if (rest.length === 11 && rest[0] === "0") rest = rest.slice(1); // +91 09810044003
      if (rest.length === 10) {
        if (!isIndianMobile(rest))
          return bad("Not a valid Indian mobile number (must start with 6-9)");
        if (isDummy(rest)) return bad("Dummy / placeholder number");
        return { phone: `91${rest}` };
      }
      if (digits.length <= 12 || !international) {
        return bad(
          `Indian number has ${rest.length} digits after 91, expected 10`,
        );
      }
    }
  }

  if (international) {
    if (digits.length < 8 || digits.length > 15) {
      return bad(`International number has ${digits.length} digits`);
    }
    return { phone: digits };
  }

  // No "+" and not an Indian-looking number.
  if (
    digits.length >= 11 &&
    digits.length <= 15 &&
    KNOWN_CC.some((code) => digits.startsWith(code))
  ) {
    if (cc === "91" && digits.length === 11) {
      return bad("11 digits - one digit extra or missing");
    }
    return {
      phone: digits,
      warning: "Assumed international number (no + sign)",
    };
  }

  if (digits.length < 10)
    return bad(`Only ${digits.length} digits, expected 10`);
  if (digits.length === 11)
    return bad("11 digits - one digit extra or missing");
  return bad(`${digits.length} digits - not a valid mobile number`);
}

/**
 * normalizePhones("98100 44003 / +91 98100 44004")
 *  -> { phone: "919810044003", extras: ["919810044004"], errors: [], warnings: [] }
 */
function normalizePhones(raw, { defaultCountryCode = DEFAULT_CC } = {}) {
  const result = { phone: "", extras: [], errors: [], warnings: [] };
  if (raw === undefined || raw === null) return result;

  let text = normalizeDigits(raw).trim().replace(/^'+/, "");
  text = text.replace(/^(?:tel|whatsapp|sms|callto):/i, "");
  text = text.replace(
    /(?:https?:\/\/)?(?:api\.)?wa\.me\/(?:send\?phone=)?/i,
    "+",
  );
  if (!text) return result;

  const expanded = expandNumericArtefacts(text);
  if (expanded.lossy) {
    result.errors.push(
      "Number was shortened by Excel (scientific notation like 9.8E+9). Format the column as Text and re-upload",
    );
    return result;
  }
  if (expanded.text !== text)
    result.warnings.push("Fixed number format from Excel");
  text = expanded.text;

  const seen = new Set();
  for (const candidate of splitCandidates(text)) {
    const r = normalizeCandidate(candidate, String(defaultCountryCode || "91"));
    if (r.error) {
      result.errors.push(r.error);
      continue;
    }
    if (seen.has(r.phone)) continue;
    seen.add(r.phone);
    if (r.warning) result.warnings.push(r.warning);
    if (!result.phone) result.phone = r.phone;
    else result.extras.push(r.phone);
  }

  // A valid number was found: bad fragments only matter as warnings.
  if (result.phone && result.errors.length) {
    result.warnings.push(
      `Ignored invalid extra number: ${result.errors.join("; ")}`,
    );
    result.errors = [];
  }
  if (result.extras.length) {
    result.warnings.push(
      `Multiple numbers found, using ${result.phone} (others saved in notes)`,
    );
  }
  return result;
}

/** Single-number convenience for callers that want a throw-on-invalid API. */
function toCanonicalPhone(raw, options) {
  const r = normalizePhones(raw, options);
  if (!r.phone)
    throw new Error(r.errors[0] || `Phone number "${raw}" is not valid`);
  return r.phone;
}

const EMAIL_STRICT_RE =
  /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/** normalizeEmails("Mailto:Foo@Bar.com; baz@x.in") -> { email, extras, error } */
function normalizeEmails(raw) {
  const result = { email: "", extras: [], error: "" };
  const text = normalizeDigits(raw).trim();
  if (!text) return result;

  const tokens = text
    .replace(/mailto:/gi, " ")
    .split(/[\s,;|/<>()[\]"]+/)
    .map((t) => t.replace(/^[.'-]+|[.'-]+$/g, "").toLowerCase())
    .filter((t) => t.includes("@"));

  for (const token of tokens) {
    if (EMAIL_STRICT_RE.test(token) && !token.includes("..")) {
      if (!result.email) result.email = token;
      else if (token !== result.email && !result.extras.includes(token))
        result.extras.push(token);
    }
  }
  if (!result.email)
    result.error = `Invalid email format (${text.slice(0, 60)})`;
  return result;
}

module.exports = {
  normalizePhones,
  normalizeEmails,
  toCanonicalPhone,
  normalizeDigits,
  isIndianMobile,
};
