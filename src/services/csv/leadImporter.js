const zlib = require("zlib");
const Papa = require("papaparse");
const Lead = require("../../models/Lead");
const {
  normalizePhones,
  normalizeEmails,
  normalizeDigits,
} = require("../../utils/contactNormalizer");

const MAX_ROWS = 50000;
const MAX_TEXT_ROWS = 5000;

/* ------------------------------------------------------------------ */
/* Header recognition                                                  */
/* ------------------------------------------------------------------ */

const HEADER_ALIASES = {
  name: [
    "name",
    "fullname",
    "customername",
    "leadname",
    "contactname",
    "clientname",
    "personname",
    "party",
    "partyname",
  ],
  firstName: ["firstname", "fname", "givenname"],
  lastName: ["lastname", "lname", "surname", "familyname"],
  phone: [
    "phone",
    "mobile",
    "phonenumber",
    "mobilenumber",
    "contact",
    "contactno",
    "contactnumber",
    "whatsapp",
    "whatsappnumber",
    "whatsappno",
    "mobilewhatsapp",
    "whatsappmobile",
    "phonewhatsapp",
    "mobileno",
    "phoneno",
    "mobno",
    "mob",
    "cell",
    "cellphone",
    "cellno",
    "telephone",
    "tel",
    "number",
    "phno",
    "ph",
    "mobile1",
    "mobile2",
    "phone1",
    "phone2",
    "alternatenumber",
    "alternatemobile",
    "altmobile",
    "altnumber",
    "alternatephone",
    "primarymobile",
    "primaryphone",
    "primarycontact",
    "secondarymobile",
    "secondaryphone",
    "mobilenumber1",
    "mobilenumber2",
  ],
  email: [
    "email",
    "emailaddress",
    "mail",
    "emailid",
    "mailid",
    "emailaddress1",
    "email1",
    "email2",
    "primaryemail",
  ],
  city: ["city", "town"],
  location: ["location", "area", "locality", "sector"],
  address: [
    "address",
    "fulladdress",
    "addr",
    "residentialaddress",
    "officeaddress",
    "currentaddress",
    "postaladdress",
  ],
  jobTitle: [
    "jobtitle",
    "designation",
    "title",
    "job",
    "position",
    "role",
    "jobrole",
  ],
  budget: ["budget"],
  budgetMin: ["budgetmin", "minbudget", "minimumbudget"],
  budgetMax: ["budgetmax", "maxbudget", "maximumbudget"],
  occupation: ["occupation", "profession"],
  age: ["age"],
  source: ["leadsource", "source"],
  notes: ["notes", "remark", "remarks", "comment", "comments", "note"],
  requirements: ["requirements", "requirement"],
};

// Last-resort "header contains keyword" matching (only when no exact alias hit).
const HEADER_CONTAINS = {
  phone: [/mobile|whatsapp|phone|\bcell|contactno|contactnumber|mobno/],
  email: [/mail/],
  name: [/name/],
  address: [/addr/],
  jobTitle: [/designation|jobtitle/],
};

const MULTI_FIELDS = new Set(["phone", "email"]);

function normalizeKey(key) {
  return normalizeDigits(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** headers: string[] -> { field: [columnIndex, ...] } */
function buildColumnMap(headers) {
  const norms = headers.map((h) => normalizeKey(h));
  const map = {};
  const claimed = new Set();

  const claim = (field, index) => {
    if (claimed.has(index)) return;
    if (!map[field]) map[field] = [];
    if (!MULTI_FIELDS.has(field) && map[field].length) return;
    map[field].push(index);
    claimed.add(index);
  };

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    norms.forEach((norm, index) => {
      if (norm && aliases.includes(norm)) claim(field, index);
    });
  }
  for (const [field, patterns] of Object.entries(HEADER_CONTAINS)) {
    if (map[field]?.length) continue;
    norms.forEach((norm, index) => {
      if (norm && !claimed.has(index) && patterns.some((re) => re.test(norm)))
        claim(field, index);
    });
  }
  return map;
}

function headerScore(cells) {
  const nonEmpty = cells.filter((c) => String(c ?? "").trim()).length;
  if (nonEmpty < 2) return { score: 0, map: {} };
  const map = buildColumnMap(cells.map((c) => String(c ?? "")));
  let score = 0;
  for (const field of Object.keys(map)) {
    score += field === "phone" || field === "email" ? 3 : 1;
  }
  // A "header" full of long free text / digits is really a data row.
  const looksLikeData = cells.some(
    (c) => /\d{8,}/.test(String(c ?? "")) || /@/.test(String(c ?? "")),
  );
  return { score: looksLikeData ? 0 : score, map };
}

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

function cleanText(value, max = 500) {
  return normalizeDigits(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function budgetUnit(str) {
  if (/cr|crore/i.test(str)) return 10000000;
  if (/\bl\b|\dl|lac|lakh|lk/i.test(str)) return 100000;
  if (/\bk\b|\dk|thousand/i.test(str)) return 1000;
  return 1;
}

function parseBudgetToken(token, fallbackUnit = null) {
  if (token === undefined || token === null || token === "") return null;
  const str = String(token).trim().toLowerCase().replace(/,/g, "");
  const num = parseFloat(str.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num)) return null;
  const unit = budgetUnit(str);
  return Math.round(num * (unit === 1 && fallbackUnit ? fallbackUnit : unit));
}

function parseBudgetRange(budgetStr) {
  if (!budgetStr) return { budgetMin: null, budgetMax: null };
  const parts = String(budgetStr)
    .split(/\s*(?:-|–|—|\bto\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const maxUnit = budgetUnit(parts[1]);
    return {
      budgetMin: parseBudgetToken(parts[0], maxUnit),
      budgetMax: parseBudgetToken(parts[1]),
    };
  }
  const single = parseBudgetToken(parts[0]);
  return { budgetMin: single, budgetMax: single };
}

function parseAge(value) {
  const n = parseInt(String(value ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) && n >= 0 && n <= 120 ? n : null;
}

function fallbackName(name, email, phone) {
  if (String(name || "").trim()) return String(name).trim();
  if (email) {
    return (
      String(email)
        .split("@")[0]
        .replace(/[._+-]+/g, " ")
        .trim() || "Email lead"
    );
  }
  if (phone) return `Lead ${String(phone).replace(/\D/g, "").slice(-4)}`;
  return "";
}

function emptyRow(rowNumber) {
  return {
    rowNumber,
    name: "",
    phone: "",
    email: "",
    city: "",
    location: "",
    budgetMin: null,
    budgetMax: null,
    address: "",
    jobTitle: "",
    occupation: "",
    age: null,
    source: "file_import",
    notes: "",
    requirements: "",
    warnings: [],
    phoneError: "",
    emailError: "",
  };
}

/**
 * Builds a finished lead row from already-extracted raw values.
 * raw = { name, phoneValues: [], emailValues: [], ...text fields }
 */
function buildRow(rowNumber, raw) {
  const row = emptyRow(rowNumber);
  const warnings = [];
  const extraNotes = [];

  // ---- phones (several columns allowed; first valid wins) ----
  const phoneErrors = [];
  const validPhones = [];
  for (const value of raw.phoneValues || []) {
    const r = normalizePhones(value);
    if (r.phone) {
      validPhones.push(r.phone, ...r.extras);
      warnings.push(...r.warnings.filter((w) => !/Multiple numbers/.test(w)));
    } else {
      phoneErrors.push(...r.errors);
    }
  }
  const uniquePhones = [...new Set(validPhones)];
  if (uniquePhones.length) {
    row.phone = uniquePhones[0];
    if (uniquePhones.length > 1) {
      extraNotes.push(`Alternate number: ${uniquePhones.slice(1).join(", ")}`);
      warnings.push(
        `Multiple numbers found, using ${row.phone} (others saved in notes)`,
      );
    }
  } else if (phoneErrors.length) {
    row.phoneError = phoneErrors[0];
  }

  // ---- emails ----
  const emailErrors = [];
  const validEmails = [];
  for (const value of raw.emailValues || []) {
    const r = normalizeEmails(value);
    if (r.email) validEmails.push(r.email, ...r.extras);
    else if (r.error) emailErrors.push(r.error);
  }
  const uniqueEmails = [...new Set(validEmails)];
  if (uniqueEmails.length) {
    row.email = uniqueEmails[0];
    if (uniqueEmails.length > 1)
      extraNotes.push(`Alternate email: ${uniqueEmails.slice(1).join(", ")}`);
  } else if (emailErrors.length) {
    row.emailError = emailErrors[0];
  }

  // ---- text fields ----
  row.name = cleanText(raw.name, 150);
  row.city = cleanText(raw.city, 100);
  row.location = cleanText(raw.location, 150);
  row.address = cleanText(raw.address, 300);
  row.jobTitle = cleanText(raw.jobTitle, 120);
  row.occupation = cleanText(raw.occupation, 120);
  row.requirements = cleanText(raw.requirements, 1000);
  row.source = cleanText(raw.source, 60) || raw.defaultSource || "file_import";
  row.notes = [cleanText(raw.notes, 1000), ...extraNotes]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 1500);

  // ---- numbers ----
  if (raw.budgetMin || raw.budgetMax) {
    row.budgetMin = parseBudgetToken(raw.budgetMin);
    row.budgetMax = parseBudgetToken(raw.budgetMax);
  } else {
    const range = parseBudgetRange(raw.budget);
    row.budgetMin = range.budgetMin;
    row.budgetMax = range.budgetMax;
  }
  row.age = parseAge(raw.age); // bad age never invalidates the whole row

  row.name = fallbackName(row.name, row.email, row.phone);
  row.warnings = [...new Set(warnings)];
  return row;
}

/* ------------------------------------------------------------------ */
/* Matrix (rows of cells) -> leads. Shared by CSV and Excel            */
/* ------------------------------------------------------------------ */

function isBlankRow(cells) {
  return !cells.some((c) => String(c ?? "").trim());
}

function looksLikePhone(value) {
  return Boolean(normalizePhones(value).phone);
}
function looksLikeEmail(value) {
  return Boolean(normalizeEmails(value).email);
}

/** Content-based column detection for files with no / unrecognised headers. */
function sniffColumns(dataRows, map, width) {
  const claimed = new Set(Object.values(map).flat());
  const sample = dataRows.slice(0, 200);
  const ratio = (index, test) => {
    let seen = 0;
    let hit = 0;
    for (const { cells } of sample) {
      const v = String(cells[index] ?? "").trim();
      if (!v) continue;
      seen += 1;
      if (test(v)) hit += 1;
    }
    return seen >= 1 ? hit / seen : 0;
  };
  for (let i = 0; i < width; i += 1) {
    if (claimed.has(i)) continue;
    if (!map.phone && ratio(i, looksLikePhone) >= 0.6) {
      map.phone = [i];
      claimed.add(i);
    } else if (!map.email && ratio(i, looksLikeEmail) >= 0.6) {
      map.email = [i];
      claimed.add(i);
    }
  }
  if (!map.name) {
    for (let i = 0; i < width; i += 1) {
      if (claimed.has(i)) continue;
      if (
        ratio(
          i,
          (v) =>
            /[a-z\u0900-\u097F]/i.test(v) && !/@/.test(v) && !/^\d+$/.test(v),
        ) >= 0.6
      ) {
        map.name = [i];
        break;
      }
    }
  }
  return map;
}

/**
 * matrix: [{ rowNumber, cells: string[] }]  (blank rows may be present)
 */
function matrixToLeads(matrix, { defaultSource = "file_import" } = {}) {
  const rows = matrix.filter((r) => !isBlankRow(r.cells));
  if (!rows.length) throw new Error("The file is empty - no rows found");

  // Header row can be below titles/logos: pick the best of the first 30 rows.
  let headerAt = -1;
  let best = { score: 0, map: {} };
  rows.slice(0, 30).forEach((r, index) => {
    const result = headerScore(r.cells);
    if (result.score > best.score) {
      best = result;
      headerAt = index;
    }
  });
  const hasUsableHeader = headerAt >= 0 && (best.map.phone || best.map.email);

  let dataRows;
  let map;
  if (hasUsableHeader) {
    map = best.map;
    dataRows = rows.slice(headerAt + 1);
  } else {
    // No recognised header: if row 1 has no contact-looking data it is a header
    // with unknown names, otherwise everything is data.
    const first = rows[0].cells;
    const firstIsData = first.some(
      (c) => looksLikePhone(c) || looksLikeEmail(c),
    );
    dataRows = firstIsData ? rows : rows.slice(1);
    map = headerAt >= 0 && firstIsData === false ? { ...best.map } : {};
  }

  const width = Math.max(...rows.map((r) => r.cells.length), 0);
  if (!map.phone || !map.email) sniffColumns(dataRows, map, width);

  if (!map.phone && !map.email) {
    const headerPreview = rows[0].cells.filter(Boolean).slice(0, 8).join(", ");
    throw new Error(
      `Could not find a Phone/Mobile/WhatsApp or Email column. Columns found: ${headerPreview || "none"}. ` +
        'Please name the columns "Name", "Mobile / WhatsApp", "Email address".',
    );
  }
  if (!dataRows.length)
    throw new Error("The file has headers but no contact rows");
  if (dataRows.length > MAX_ROWS) {
    throw new Error(
      `File has ${dataRows.length} rows. Maximum ${MAX_ROWS} rows per upload - please split the file.`,
    );
  }

  const pick = (cells, field) => {
    const idx = map[field]?.[0];
    return idx === undefined ? "" : cells[idx];
  };

  return dataRows.map(({ rowNumber, cells }) => {
    let name = pick(cells, "name");
    if (!String(name ?? "").trim() && (map.firstName || map.lastName)) {
      name = `${pick(cells, "firstName") || ""} ${pick(cells, "lastName") || ""}`;
    }
    return buildRow(rowNumber, {
      name,
      phoneValues: (map.phone || []).map((i) => cells[i]),
      emailValues: (map.email || []).map((i) => cells[i]),
      city: pick(cells, "city"),
      location: pick(cells, "location"),
      address: pick(cells, "address"),
      jobTitle: pick(cells, "jobTitle"),
      budget: pick(cells, "budget"),
      budgetMin: pick(cells, "budgetMin"),
      budgetMax: pick(cells, "budgetMax"),
      occupation: pick(cells, "occupation"),
      age: pick(cells, "age"),
      source: pick(cells, "source"),
      notes: pick(cells, "notes"),
      requirements: pick(cells, "requirements"),
      defaultSource,
    });
  });
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le"); // Excel "Unicode text"
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(buffer)
      .replace(/^\uFEFF/, "");
  } catch {
    // Old Excel "CSV" files are Windows-1252, not UTF-8.
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

function parseCsvBuffer(buffer) {
  const text = decodeText(buffer);
  const result = Papa.parse(text, {
    header: false,
    skipEmptyLines: false,
    delimitersToGuess: [",", ";", "\t", "|"],
  });
  // Ragged rows / stray quotes are tolerated: Papa still returns the data.
  const matrix = (result.data || []).map((cells, index) => ({
    rowNumber: index + 1,
    cells: (Array.isArray(cells) ? cells : [cells]).map((c) =>
      String(c ?? "").trim(),
    ),
  }));
  if (!matrix.some((r) => !isBlankRow(r.cells))) {
    const first = result.errors?.[0];
    throw new Error(
      first
        ? `CSV could not be read: ${first.message}`
        : "The CSV file is empty",
    );
  }
  return matrixToLeads(matrix);
}

/* ------------------------------------------------------------------ */
/* XLSX (dependency-free reader)                                       */
/* ------------------------------------------------------------------ */

const MAX_INFLATED_BYTES = 300 * 1024 * 1024;

function extractZipEntries(buffer) {
  let eocd = -1;
  for (
    let i = buffer.length - 22;
    i >= Math.max(0, buffer.length - 65557);
    i -= 1
  ) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Excel file is not a valid .xlsx workbook");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error(
      "This Excel file is too large/complex (ZIP64). Please save it again as a normal .xlsx or CSV",
    );
  }
  const entries = new Map();
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    // Only the parts we need; skips images/styles/etc. entirely.
    if (
      !/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(
        name,
      )
    )
      continue;

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error("Excel workbook has an invalid ZIP entry");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(compressed, {
          maxOutputLength: MAX_INFLATED_BYTES,
        });
      } catch {
        throw new Error("Excel file is corrupted or too large to read");
      }
    } else
      throw new Error(
        "This Excel workbook uses an unsupported compression method",
      );
    total += data.length;
    if (total > MAX_INFLATED_BYTES)
      throw new Error("Excel file is too large to read");
    entries.set(name, data.toString("utf8"));
  }
  return entries;
}

function xmlDecode(value) {
  return String(value ?? "")
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (_, ent) => {
      if (ent === "lt") return "<";
      if (ent === "gt") return ">";
      if (ent === "quot") return '"';
      if (ent === "apos") return "'";
      if (ent === "amp") return "&";
      const code =
        ent[1] === "x"
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function parseAttrs(text) {
  const attrs = {};
  for (const m of String(text || "").matchAll(
    /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    attrs[m[1]] = xmlDecode(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

function columnIndex(reference) {
  const letters =
    String(reference || "")
      .match(/^[A-Z]+/i)?.[0]
      ?.toUpperCase() || "A";
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function collectText(xml) {
  // Phonetic (furigana) runs are not part of the visible value.
  const cleaned = String(xml || "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  return [...cleaned.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)]
    .map((part) => xmlDecode(part[1] || ""))
    .join("");
}

function readSharedStrings(entries) {
  const xml = entries.get("xl/sharedStrings.xml") || "";
  const list = [];
  for (const item of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    list.push(collectText(item[1] || ""));
  }
  return list;
}

/** Ordered list of worksheets [{ name, path, hidden }] from workbook.xml. */
function listSheets(entries) {
  const workbook = entries.get("xl/workbook.xml") || "";
  const rels = entries.get("xl/_rels/workbook.xml.rels") || "";
  const relTarget = new Map();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = parseAttrs(m[1]);
    if (a.Id && a.Target) {
      const target = a.Target.replace(/^\//, "");
      relTarget.set(a.Id, target.startsWith("xl/") ? target : `xl/${target}`);
    }
  }
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const a = parseAttrs(m[1]);
    const path = relTarget.get(a["r:id"]);
    if (path && entries.has(path)) {
      sheets.push({
        name: a.name,
        path,
        hidden: /hidden/i.test(a.state || ""),
      });
    }
  }
  if (!sheets.length) {
    // Fallback for unusual workbooks: any worksheet part, in numeric order.
    [...entries.keys()]
      .filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .forEach((path) => sheets.push({ name: path, path, hidden: false }));
  }
  return sheets;
}

function sheetToMatrix(sheetXml, sharedStrings) {
  const matrix = [];
  let autoRow = 0;
  // Handles both <row ...>...</row> and self-closing <row .../>. (Matching only
  // the first form made an empty <row/> swallow the NEXT row's cells.)
  for (const rowMatch of sheetXml.matchAll(
    /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g,
  )) {
    const rowAttrs = parseAttrs(rowMatch[1]);
    autoRow += 1;
    const rowNumber = Number(rowAttrs.r) || autoRow;
    autoRow = rowNumber;
    if (rowAttrs.hidden === "1") {
      // hidden rows are still data - keep them
    }
    const cells = [];
    let autoCol = -1;
    for (const cellMatch of (rowMatch[2] || "").matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const attrs = parseAttrs(cellMatch[1]);
      const body = cellMatch[2] || "";
      const col = attrs.r ? columnIndex(attrs.r) : autoCol + 1;
      autoCol = col;
      const type = attrs.t || "";
      const rawValue = body.match(/<v\b[^>]*?>([\s\S]*?)<\/v>/)?.[1];
      let parsed = "";
      if (type === "s")
        parsed =
          rawValue != null ? (sharedStrings[Number(rawValue)] ?? "") : "";
      else if (type === "inlineStr") parsed = collectText(body);
      else if (type === "str") parsed = xmlDecode(rawValue ?? "");
      else if (type === "b") parsed = rawValue === "1" ? "TRUE" : "FALSE";
      else if (type === "e") parsed = "";
      else parsed = rawValue == null ? "" : xmlDecode(rawValue);
      cells[col] = String(parsed).trim();
    }
    for (let i = 0; i < cells.length; i += 1)
      if (cells[i] === undefined) cells[i] = "";
    matrix.push({ rowNumber, cells });
  }
  return matrix;
}

function parseExcelBuffer(buffer) {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0xd0cf11e0) {
    throw new Error(
      "This is an old .xls or password-protected Excel file. Open it in Excel and use Save As -> Excel Workbook (.xlsx) or CSV.",
    );
  }
  const entries = extractZipEntries(buffer);
  const sheets = listSheets(entries);
  if (!sheets.length)
    throw new Error("Excel workbook has no readable worksheet");
  const sharedStrings = readSharedStrings(entries);

  // First visible sheet that actually has contact data; otherwise report the first error.
  const ordered = [
    ...sheets.filter((s) => !s.hidden),
    ...sheets.filter((s) => s.hidden),
  ];
  let firstError = null;
  for (const sheet of ordered) {
    const matrix = sheetToMatrix(entries.get(sheet.path), sharedStrings);
    if (!matrix.some((r) => !isBlankRow(r.cells))) continue;
    try {
      return matrixToLeads(matrix);
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  throw firstError || new Error("Excel worksheet is empty");
}

/** Detects the real format from the bytes, not just the file extension. */
function parseLeadFile(buffer, filename = "") {
  const isZip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isOle = buffer.length > 4 && buffer.readUInt32BE(0) === 0xd0cf11e0;
  if (isZip || isOle) return parseExcelBuffer(buffer);
  if (/\.xlsx$/i.test(filename) && buffer.length < 4)
    throw new Error("File is empty");
  return parseCsvBuffer(buffer);
}

/* ------------------------------------------------------------------ */
/* Pasted text                                                         */
/* ------------------------------------------------------------------ */

const EMAIL_FIND_RE = /[^\s@,;|<>()]+@[^\s@,;|<>()]+\.[^\s@,;|<>()]+/g;
const PHONE_FIND_RE = /\+?\(?\d[\d\s().-]{6,}\d/g;

function parseLeadText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const rows = [];
  lines.forEach((rawLine, idx) => {
    let line = normalizeDigits(rawLine).trim();
    if (!line || rows.length >= MAX_TEXT_ROWS) return;
    if (
      /name/i.test(line) &&
      /(phone|mobile|number|email)/i.test(line) &&
      !/\d{6,}/.test(line)
    )
      return;
    line = line.replace(/^\d{1,4}[.)]\s+/, "");

    const emails = line.match(EMAIL_FIND_RE) || [];
    emails.forEach((e) => {
      line = line.replace(e, " ");
    });
    const phones = line.match(PHONE_FIND_RE) || [];
    phones.forEach((p) => {
      line = line.replace(p, " ");
    });

    const name = line
      .replace(/[,;|\t]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s/&:-]+|[\s/&:-]+$/g, "")
      .trim();
    rows.push(
      buildRow(idx + 1, {
        name,
        phoneValues: phones,
        emailValues: emails,
        defaultSource: "bulk_paste",
      }),
    );
  });
  return rows;
}

/* ------------------------------------------------------------------ */
/* Validation + duplicate analysis                                     */
/* ------------------------------------------------------------------ */

function validateRow(row) {
  const errors = [];
  const hasPhone = Boolean(String(row.phone || "").trim());
  const hasEmail = Boolean(String(row.email || "").trim());

  if (!hasPhone && !hasEmail) {
    if (row.phoneError) errors.push(row.phoneError);
    if (row.emailError) errors.push(row.emailError);
    if (!errors.length)
      errors.push(
        "At least one valid email address or phone number is required",
      );
  }
  if (
    row.age !== null &&
    row.age !== undefined &&
    (Number.isNaN(row.age) || row.age < 0 || row.age > 120)
  ) {
    errors.push("Invalid age");
  }
  return errors;
}

function phoneLookupVariants(phone) {
  const variants = [phone];
  if (/^91\d{10}$/.test(phone))
    variants.push(phone.slice(2), `0${phone.slice(2)}`, `+${phone}`);
  return variants;
}

function canonicalStoredPhone(stored) {
  const r = normalizePhones(stored);
  return r.phone || String(stored || "").replace(/\D/g, "");
}

async function analyzeRows(ownerId, rows) {
  const phones = [
    ...new Set(rows.map((r) => String(r.phone || "").trim()).filter(Boolean)),
  ];
  const emails = [
    ...new Set(
      rows
        .map((r) =>
          String(r.email || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];

  // Query in chunks so a 50k-row file never builds an oversized $in.
  const CHUNK = 5000;
  const existingPhoneSet = new Set();
  const existingEmailSet = new Set();
  const phoneVariants = phones.flatMap(phoneLookupVariants);
  for (let i = 0; i < phoneVariants.length; i += CHUNK) {
    const found = await Lead.find(
      { ownerId, phone: { $in: phoneVariants.slice(i, i + CHUNK) } },
      { phone: 1 },
    ).lean();
    found.forEach((l) => existingPhoneSet.add(canonicalStoredPhone(l.phone)));
  }
  for (let i = 0; i < emails.length; i += CHUNK) {
    const found = await Lead.find(
      { ownerId, email: { $in: emails.slice(i, i + CHUNK) } },
      { email: 1 },
    ).lean();
    found.forEach((l) =>
      existingEmailSet.add(String(l.email || "").toLowerCase()),
    );
  }

  const seenPhones = new Set();
  const seenEmails = new Set();

  const analyzed = rows.map((row) => {
    const errors = validateRow(row);
    const phone = String(row.phone || "").trim();
    const email = String(row.email || "")
      .trim()
      .toLowerCase();
    const warnings = [...(row.warnings || [])];
    if (!phone && row.phoneError && email)
      warnings.push(
        `${row.phoneError} - phone skipped, email will be imported`,
      );
    if (!email && row.emailError && phone)
      warnings.push(
        `${row.emailError} - email skipped, phone will be imported`,
      );

    let duplicateReason = null;
    if (phone && existingPhoneSet.has(phone))
      duplicateReason = "Phone already exists in your leads";
    else if (email && existingEmailSet.has(email))
      duplicateReason = "Email already exists in your leads";
    else if (phone && seenPhones.has(phone))
      duplicateReason = "Duplicate phone number within this file";
    else if (email && seenEmails.has(email))
      duplicateReason = "Duplicate email within this file";
    if (phone) seenPhones.add(phone);
    if (email) seenEmails.add(email);

    const status = errors.length
      ? "invalid"
      : duplicateReason
        ? "duplicate"
        : "valid";
    return {
      ...row,
      errors,
      warnings,
      isDuplicate: Boolean(duplicateReason),
      duplicateReason,
      status,
    };
  });

  return {
    rows: analyzed,
    summary: {
      total: analyzed.length,
      valid: analyzed.filter((r) => r.status === "valid").length,
      invalid: analyzed.filter((r) => r.status === "invalid").length,
      duplicate: analyzed.filter((r) => r.status === "duplicate").length,
      withWarnings: analyzed.filter(
        (r) => r.status === "valid" && r.warnings.length,
      ).length,
      whatsappAvailable: analyzed.filter((r) => r.status === "valid" && r.phone)
        .length,
      emailAvailable: analyzed.filter((r) => r.status === "valid" && r.email)
        .length,
      bothAvailable: analyzed.filter(
        (r) => r.status === "valid" && r.phone && r.email,
      ).length,
    },
  };
}

module.exports = {
  parseCsvBuffer,
  parseExcelBuffer,
  parseLeadFile,
  parseLeadText,
  validateRow,
  analyzeRows,
};
