// Quote model: the editable shape the phone app works with, and its conversion to and from SKN.
//
// Quote = { title, projectNo, buildingTitle, chapters: [{ num, title, subchapters: [{ num, title,
//           items: [{ id, code?, unit, qty, price, description }] }] }] }

import { parseSkn, entries, buildSkn, serializeSkn, QTY_MAX, PRICE_MAX } from "./skn.mjs";

/** Sub-chapters as they appear in the engineers' files (blue-book numbering). 04/05 are standard blue-book chapters not yet seen in a file. */
export const SUBCHAPTERS = Object.freeze([
  [1, "עבודות פרוק והריסה"],
  [2, "עבודות בטון"],
  [4, "עבודות בנייה"],
  [5, "עבודות איטום"],
  [6, "עבודות נגרות ומסגרות אומן"],
  [7, "מתקני תברואה"],
  [8, "עבודות חשמל"],
  [9, "עבודות טיח"],
  [10, "עבודות ריצוף וחיפוי"],
  [11, "עבודות צבע"],
  [12, "עבודות אלומיניום"],
  [15, "מתקני מיזוג אוויר"],
  [19, "מסגרות חרש"],
  [22, "רכיבים מתועשים בבניין"],
  [99, "כללי"],
]);

/** Unit codes offered in the app. 05 is tonnes by context (steel items), unconfirmed. */
export const UNIT_OPTIONS = Object.freeze([
  ["01", "יח'"],
  ["02", 'מ"א'],
  ["03", 'מ"ר'],
  ["05", "טון"],
  ["09", "קומפ'"],
]);

export const unitLabel = code => UNIT_OPTIONS.find(([c]) => c === code)?.[1] ?? code;

let seq = 0;
export const newId = () => `i${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const strip = (text, re) => text.replace(re, "").trim();

/** Read an SKN file into a quote. Headings lose their "פרק 01 -" style prefixes; buildSkn adds them back. */
export function sknToQuote(bytes) {
  const doc = parseSkn(bytes);
  const quote = { title: "", projectNo: 0, buildingTitle: "", chapters: [] };
  let chapter = null, sub = null;
  const ensureChapter = num => {
    if (!chapter) { chapter = { num, title: "", subchapters: [] }; quote.chapters.push(chapter); }
    return chapter;
  };
  const keepCode = doc.codeWidth === 9;
  for (const e of entries(doc)) {
    if (e.level === "root") {
      if (!quote.title) quote.title = e.description;
      if (e.projectNo) quote.projectNo = e.projectNo;
    } else if (e.level === "building") {
      quote.buildingTitle = strip(e.description, /^מבנה\s*\d+\s*/);
    } else if (e.level === "chapter") {
      chapter = { num: Number(e.chapter) || quote.chapters.length + 1, title: strip(e.description, /^פרק\s*\d+\s*-?\s*/), subchapters: [] };
      quote.chapters.push(chapter);
      sub = null;
    } else if (e.level === "subchapter") {
      sub = { num: Number(e.subchapter), title: strip(e.description, /^תת\s*פרק\s*\d+\s*-?\s*/), items: [] };
      ensureChapter(Number(e.chapter) || 1).subchapters.push(sub);
    } else if (e.level === "item" && (e.qty > 0 || (e.unit && e.unit !== "00"))) {
      if (!sub) { sub = { num: 99, title: "כללי", items: [] }; ensureChapter(1).subchapters.push(sub); }
      sub.items.push({ id: newId(), code: keepCode ? e.code : undefined, unit: e.unit || "01", qty: e.qty, price: e.price, description: e.description });
    }
  }
  if (!quote.chapters.length) throw new Error("לא נמצאו סעיפים בקובץ");
  for (const ch of quote.chapters) if (!ch.title) ch.title = quote.buildingTitle || "אומדן עלות שיקום";
  return quote;
}

/** Write a quote back to SKN bytes (prices included), for Binarit. */
export function quoteToSkn(quote, { eol = "\r\n" } = {}) {
  const chapters = quote.chapters
    .map(ch => ({ num: ch.num, title: ch.title, subchapters: ch.subchapters.filter(s => s.items.length).map(s => ({ num: s.num, title: s.title, items: s.items.map(({ code, unit, qty, price, description }) => ({ code, unit, qty, price, description })) })) }))
    .filter(ch => ch.subchapters.length);
  if (!chapters.length) throw new Error("אין סעיפים לייצוא");
  return serializeSkn(buildSkn({ title: quote.title || "הצעת מחיר", projectNo: quote.projectNo || 0, buildingTitle: quote.buildingTitle || chapters[0].title, chapters, eol }));
}

const round2 = n => Math.round(n * 100) / 100;

/** Totals for display: per subchapter, per chapter, grand total and how many items still have no price. */
export function quoteTotals(quote) {
  let total = 0, unpriced = 0, count = 0;
  const chapters = quote.chapters.map(ch => {
    let chTotal = 0;
    const subchapters = ch.subchapters.map(s => {
      const t = round2(s.items.reduce((a, it) => a + it.qty * it.price, 0));
      for (const it of s.items) { count++; if (!it.price) unpriced++; }
      chTotal += t;
      return t;
    });
    total += chTotal;
    return { total: round2(chTotal), subchapters };
  });
  return { total: round2(total), chapters, unpriced, count };
}

/** Validate a user-entered number for a quantity or a price. Returns the rounded number or throws. */
export function parseAmount(raw, kind) {
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,\s₪]/g, ""));
  const max = kind === "qty" ? QTY_MAX : PRICE_MAX;
  if (!Number.isFinite(n) || n < 0 || n > max) throw new RangeError(kind === "qty" ? "כמות לא תקינה" : "מחיר לא תקין");
  return round2(n);
}
