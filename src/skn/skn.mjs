// SKN — the bill-of-quantities exchange format of Israel's Ministry of Construction
// and Housing (משהב"ש), which Binarit imports and exports.
//
// Layout, as reverse-engineered from real files (see samples/skn, not in git):
//   - windows-1255 text; every content line is followed by one blank line;
//     line endings are CRLF or LF depending on the program that wrote the file.
//   - each content line is a fixed-width prefix plus a 150-char description field:
//       code (8 or 9 digits) | unit (2 digits, or 2 spaces on headings)
//       | quantity  ######.##  | unit price  #########.##  | description
//   - the very first line of a 9-digit file is a header whose number field holds the
//     project number instead of a price:  00000000000000000.000000000NNNNN
//   - a description longer than 150 chars continues on the next line(s), either with a
//     blank prefix or as a record that repeats the item's code with zero unit/qty/price.
//   - descriptions are padded to 150 chars, right-aligned (engineer files) or
//     left-aligned (Binarit's own export). Hebrew is stored in logical order.
//
// The document model keeps every physical line, so parse → serialize is byte-exact,
// and editing a quantity or price rewrites only that line's number columns.

import { decode1255, encode1255 } from "./codec.mjs";

export const DESC_WIDTH = 150;
export const QTY_MAX = 999999.99;
export const PRICE_MAX = 999999999.99;

/** Unit codes seen in real files. Inferred from context, confirm with Shapir before relying on them. */
export const UNITS = Object.freeze({
  "01": "יח'",
  "02": 'מ"א',
  "03": 'מ"ר',
  "05": "טון", // only on steel items (qty 0.7, 3, 9): tonnes by context, unconfirmed
  "09": "קומפ'",
});

const RECORD_RE = /^(\d{8,9})(\d\d| {2})(\d{6}\.\d\d)(\d{9}\.\d\d)/;
const HEADER_RE = /^(0{17})\.(\d{14})/;
const LINE_RE = /([^\r\n]*)(\r\n|\n|$)/g;

/** Segment widths [building, chapter, subchapter, item] per code length. */
const SEGMENTS = { 9: [2, 2, 2, 3], 8: [2, 2, 1, 3] };

// ---------- physical layer ----------

/**
 * @typedef {{kind:"record", code:string, unit:string, qty:number, price:number, desc:string, eol:string}
 *         | {kind:"header", prefix:string, projectNo:number, desc:string, eol:string}
 *         | {kind:"text", text:string, eol:string}} SknLine
 * @typedef {{lines: SknLine[], eol: string, align: "right"|"left", codeWidth: number}} SknDoc
 */

/** @param {Uint8Array|Buffer} bytes @returns {SknDoc} */
export function parseSkn(bytes) {
  const text = decode1255(bytes);
  const lines = [];
  for (const m of text.matchAll(LINE_RE)) {
    const [, body, eol] = m;
    if (body === "" && eol === "") break;
    const header = lines.length === 0 ? HEADER_RE.exec(body) : null;
    const rec = header ? null : RECORD_RE.exec(body);
    if (header) {
      lines.push({ kind: "header", prefix: header[0], projectNo: Number(header[2]), desc: body.slice(header[0].length), eol });
    } else if (rec) {
      lines.push({ kind: "record", code: rec[1], unit: rec[2].trim(), qty: Number(rec[3]), price: Number(rec[4]), desc: body.slice(rec[0].length), eol });
    } else {
      lines.push({ kind: "text", text: body, eol });
    }
  }
  const records = lines.filter(l => l.kind === "record");
  const eol = lines.find(l => l.eol)?.eol ?? "\r\n";
  return { lines, eol, align: detectAlign(records), codeWidth: records.find(r => r.qty > 0)?.code.length ?? records[0]?.code.length ?? 9 };
}

function detectAlign(records) {
  let right = 0, left = 0;
  for (const r of records) {
    if (r.desc.length < DESC_WIDTH / 2) continue;
    if (/^ +\S/.test(r.desc)) right++;
    else if (/\S +$/.test(r.desc)) left++;
  }
  return left > right ? "left" : "right";
}

function fmtNum(n, width) {
  return n.toFixed(2).padStart(width, "0");
}

function recordPrefix(r) {
  return r.code + (r.unit ? r.unit.padStart(2, "0") : "  ") + fmtNum(r.qty, 9) + fmtNum(r.price, 12);
}

/** @param {SknDoc} doc @returns {Uint8Array} */
export function serializeSkn(doc) {
  let out = "";
  for (const l of doc.lines) {
    if (l.kind === "record") out += recordPrefix(l) + l.desc + l.eol;
    else if (l.kind === "header") out += l.prefix + l.desc + l.eol;
    else out += l.text + l.eol;
  }
  return encode1255(out);
}

// ---------- logical layer ----------

/** @param {string} code */
export function codeParts(code) {
  const widths = SEGMENTS[code.length];
  if (!widths) throw new RangeError(`Unsupported SKN code length ${code.length}: ${code}`);
  const parts = [];
  let i = 0;
  for (const w of widths) { parts.push(code.slice(i, i + w)); i += w; }
  const [building, chapter, subchapter, item] = parts;
  const zero = s => /^0+$/.test(s);
  const level = !zero(item) ? "item" : !zero(subchapter) ? "subchapter" : !zero(chapter) ? "chapter" : !zero(building) ? "building" : "root";
  return { building, chapter, subchapter, item, level };
}

function unpad(segment, align) {
  return align === "right" ? segment.trimStart() : segment.trimEnd();
}

/**
 * Logical entries: one per heading or item, continuation lines folded into the description.
 * `lineIndex` points at the entry's record in `doc.lines`.
 * @param {SknDoc} doc
 */
export function entries(doc) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { cur.description = cur.description.trim(); out.push(cur); cur = null; } };
  doc.lines.forEach((l, i) => {
    if (l.kind === "header") {
      flush();
      cur = { level: "root", code: null, unit: "", unitName: null, qty: 0, price: 0, description: l.desc, projectNo: l.projectNo, lineIndex: i };
    } else if (l.kind === "record") {
      const isContinuation = cur && cur.code === l.code && !hasUnit(l.unit) && l.qty === 0 && l.price === 0 && cur.level === "item";
      if (isContinuation) { cur.description += unpad(l.desc, doc.align); return; }
      flush();
      const { level, building, chapter, subchapter, item } = codeParts(l.code);
      cur = { level, code: l.code, building, chapter, subchapter, item, unit: l.unit, unitName: UNITS[l.unit] ?? null, qty: l.qty, price: l.price, description: l.desc, lineIndex: i };
    } else if (l.text.trim() && cur) {
      cur.description += unpad(l.text.slice(recordPrefix({ code: "0".repeat(doc.codeWidth), unit: "", qty: 0, price: 0 }).length), doc.align);
    }
  });
  flush();
  return out;
}

/** Items only (entries that carry a quantity), with their line total. */
export function items(doc) {
  return entries(doc)
    .filter(e => e.level === "item" && e.qty > 0)
    .map(e => ({ ...e, total: round2(e.qty * e.price) }));
}

/** "00" marks a continuation record, blank marks a heading. */
const hasUnit = u => Boolean(u) && u !== "00";

const round2 = n => Math.round(n * 100) / 100;

/** Grand total and per-subchapter totals, the way Binarit sums a bill of quantities. */
export function totals(doc) {
  const bySubchapter = new Map();
  let total = 0, unpriced = 0;
  for (const it of items(doc)) {
    const key = it.building + it.chapter + it.subchapter;
    bySubchapter.set(key, round2((bySubchapter.get(key) ?? 0) + it.total));
    total += it.total;
    if (it.price === 0) unpriced++;
  }
  return { total: round2(total), bySubchapter, unpriced };
}

function checkAmount(value, max, what) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new RangeError(`${what} must be a number between 0 and ${max}, got ${value}`);
  }
}

function findItemRecord(doc, code) {
  const rec = doc.lines.find(l => l.kind === "record" && l.code === code && (hasUnit(l.unit) || l.qty > 0));
  if (!rec) throw new Error(`No item with code ${code}`);
  return rec;
}

/** Set an item's unit price. Mutates `doc`; only that line's price column changes on serialize. */
export function setPrice(doc, code, price) {
  checkAmount(price, PRICE_MAX, "Price");
  findItemRecord(doc, code).price = round2(price);
  return doc;
}

/** Set an item's quantity. Mutates `doc`. */
export function setQty(doc, code, qty) {
  checkAmount(qty, QTY_MAX, "Quantity");
  findItemRecord(doc, code).qty = round2(qty);
  return doc;
}

// ---------- building a new file ----------

const two = n => String(n).padStart(2, "0");

function padDesc(text, align) {
  return align === "right" ? text.padStart(DESC_WIDTH, " ") : text.padEnd(DESC_WIDTH, " ");
}

function pushRecord(lines, eol, align, rec, description) {
  const text = description.replace(/[\r\n\t]+/g, " ").trim();
  const chunks = [];
  for (let i = 0; i < text.length; i += DESC_WIDTH) chunks.push(text.slice(i, i + DESC_WIDTH));
  if (!chunks.length) chunks.push("");
  const blankPrefix = " ".repeat(recordPrefix(rec).length);
  lines.push({ kind: "record", ...rec, desc: padDesc(chunks[0], align), eol }, { kind: "text", text: "", eol });
  for (const c of chunks.slice(1)) lines.push({ kind: "text", text: blankPrefix + padDesc(c, align), eol }, { kind: "text", text: "", eol });
}

/**
 * Build a new 9-digit SKN document (building 01), in the engineer-file convention.
 * @param {{projectNo?: number, title: string, buildingTitle?: string, eol?: string, align?: "right"|"left", itemStep?: number,
 *   chapters: {num?: number, title: string, subchapters: {num: number, title: string, items: {code?: string, unit: string, qty: number, price?: number, description: string}[]}[]}[]}} spec
 * An item's `code` is kept when given (e.g. an engineer's numbering); items without one are numbered after it.
 * @returns {SknDoc}
 */
export function buildSkn(spec) {
  const eol = spec.eol ?? "\r\n";
  const align = spec.align ?? "right";
  const step = spec.itemStep ?? 1;
  if (!spec.title?.trim()) throw new Error("title is required");
  if (!Array.isArray(spec.chapters) || spec.chapters.length === 0) throw new Error("at least one chapter is required");
  if (spec.chapters.length > 99) throw new RangeError("at most 99 chapters");

  const lines = [];
  const projectNo = spec.projectNo ?? 0;
  if (!Number.isInteger(projectNo) || projectNo < 0 || projectNo > 99999999999999) throw new RangeError("projectNo must be a non-negative integer of up to 14 digits");
  const headerPrefix = "0".repeat(17) + "." + String(projectNo).padStart(14, "0");
  lines.push({ kind: "header", prefix: headerPrefix, projectNo, desc: padDesc(spec.title.trim(), align), eol }, { kind: "text", text: "", eol });

  const B = "01";
  pushRecord(lines, eol, align, { code: B + "0000000", unit: "", qty: 0, price: 0 }, `מבנה ${B} ${spec.buildingTitle ?? spec.chapters[0].title}`);
  spec.chapters.forEach((ch, ci) => {
    const cnum = ch.num ?? ci + 1;
    if (!Number.isInteger(cnum) || cnum < 1 || cnum > 99) throw new RangeError(`Chapter number must be 1-99, got ${cnum}`);
    const C = two(cnum);
    pushRecord(lines, eol, align, { code: B + C + "00000", unit: "", qty: 0, price: 0 }, `פרק ${C} - ${ch.title}`);
    for (const sub of ch.subchapters) {
      if (!Number.isInteger(sub.num) || sub.num < 1 || sub.num > 99) throw new RangeError(`Subchapter number must be 1-99, got ${sub.num}`);
      const S = two(sub.num);
      pushRecord(lines, eol, align, { code: B + C + S + "000", unit: "", qty: 0, price: 0 }, `תת פרק ${S} ${sub.title}`);
      const prefix = B + C + S;
      const taken = new Set(sub.items.filter(it => it.code?.startsWith(prefix)).map(it => Number(it.code.slice(6))));
      let last = 0;
      for (const it of sub.items) {
        let code;
        if (it.code !== undefined && it.code !== null && it.code !== "") {
          if (!/^\d{9}$/.test(it.code) || !it.code.startsWith(prefix) || it.code.endsWith("000")) throw new Error(`Item code ${it.code} does not belong to subchapter ${prefix}`);
          code = it.code;
          last = Number(code.slice(6));
        } else {
          let n = last + step;
          while (taken.has(n)) n++;
          if (n > 999) throw new RangeError(`Too many items in subchapter ${S}`);
          taken.add(n);
          last = n;
          code = prefix + String(n).padStart(3, "0");
        }
        if (!/^\d{2}$/.test(it.unit)) throw new Error(`Item unit must be a 2-digit SKN unit code, got "${it.unit}"`);
        checkAmount(it.qty, QTY_MAX, "Quantity");
        checkAmount(it.price ?? 0, PRICE_MAX, "Price");
        pushRecord(lines, eol, align, { code, unit: it.unit, qty: round2(it.qty), price: round2(it.price ?? 0) }, it.description);
      }
    }
  });
  return { lines, eol, align, codeWidth: 9 };
}
