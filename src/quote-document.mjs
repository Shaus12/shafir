// The quote as a printable A4 document (HTML string), shared by the phone's print fallback
// and the server PDF renderer (api/pdf.mjs), plus validation for quotes that arrive over HTTP.

import { quoteTotals, unitLabel, itemLabel } from "./skn/model.mjs";

const COMPANY = 'שפיר - שיקום נזקים בע"מ';

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = n => n.toLocaleString("he-IL", { maximumFractionDigits: 2 });
const two = n => String(n).padStart(2, "0");

export const DOC_CSS = `
.pdfdoc{width:100%;direction:rtl;font-family:"IBM Plex Sans Hebrew",Arial,sans-serif;color:#1c2220;font-size:10pt;line-height:1.45;background:#fff}
.pdfdoc header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #1c2220;padding-bottom:8px;margin-bottom:12px}
.pdfdoc .co{font-weight:700;font-size:15pt}
.pdfdoc .meta{text-align:left;font-size:9pt;color:#4a5451}
.pdfdoc h1{font-size:13pt;margin:0 0 2px}
.pdfdoc h2{font-size:11pt;margin:14px 0 6px;padding:4px 8px;background:#eceeed}
.pdfdoc table{width:100%;border-collapse:collapse;margin-bottom:4px}
.pdfdoc th{font-size:8.5pt;text-align:start;color:#4a5451;border-bottom:1px solid #9aa3a0;padding:3px 4px;font-weight:600}
.pdfdoc td{padding:4px;border-bottom:1px solid #dfe3e1;vertical-align:top}
.pdfdoc td.n,.pdfdoc th.n{text-align:left;white-space:nowrap;font-variant-numeric:tabular-nums}
.pdfdoc td.c{white-space:nowrap;color:#4a5451;font-size:8.5pt}
.pdfdoc tr.sub td{font-weight:700;border-bottom:1.5px solid #1c2220}
.pdfdoc .summary{margin-top:16px;width:60%;margin-inline-start:auto}
.pdfdoc .summary td{border-bottom:1px solid #dfe3e1}
.pdfdoc .summary tr.grand td{font-weight:700;font-size:12pt;border-top:2px solid #1c2220;border-bottom:none}
.pdfdoc tr,.pdfdoc h2{break-inside:avoid}
.pdfdoc h2{break-after:avoid}
.pdfdoc thead{display:table-header-group}
.pdfdoc footer{margin-top:18px;font-size:8.5pt;color:#4a5451}
`;

/** File name for an exported quote (no extension). */
export function quoteFileBase(q, { prices }) {
  return (q.title || "הצעת מחיר").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) + (prices ? "" : " - כתב כמויות");
}

/**
 * The inner HTML of the document (styles included). `prices: false` leaves out unit prices, line totals and sums.
 * The date is in Israel time, so the server (UTC) prints the same date as the phone.
 */
export function quoteDocumentHtml(q, { prices, date = new Date() }) {
  const t = quoteTotals(q);
  const day = date.toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" });
  let body = "";
  q.chapters.forEach((ch, ci) => {
    if (!ch.subchapters.some(s => s.items.length)) return;
    body += `<h2>פרק ${two(ch.num)} - ${esc(ch.title)}</h2>`;
    ch.subchapters.forEach((sub, si) => {
      if (!sub.items.length) return;
      const rows = sub.items.map((it, ii) => `<tr><td class="c">${esc(itemLabel(ch, sub, it, ii))}</td><td>${esc(it.description)}</td><td class="c">${esc(unitLabel(it.unit))}</td><td class="n">${qtyFmt(it.qty)}</td>${prices ? `<td class="n">${money(it.price)}</td><td class="n">${money(it.qty * it.price)}</td>` : ""}</tr>`).join("");
      body += `<table><thead><tr><th colspan="${prices ? 6 : 4}">תת פרק ${two(sub.num)} - ${esc(sub.title)}</th></tr>
        <tr><th>סעיף</th><th>תאור</th><th>יחידה</th><th class="n">כמות</th>${prices ? `<th class="n">מחיר יחידה</th><th class="n">סה"כ</th>` : ""}</tr></thead>
        <tbody>${rows}${prices ? `<tr class="sub"><td colspan="5">סה"כ תת פרק ${two(sub.num)}</td><td class="n">${money(t.chapters[ci].subchapters[si])}</td></tr>` : ""}</tbody></table>`;
    });
  });
  const summary = prices ? `<table class="summary"><tbody>${q.chapters.flatMap((ch, ci) => ch.subchapters.map((s, si) => s.items.length ? `<tr><td>${two(ch.num)}.${two(s.num)} ${esc(s.title)}</td><td class="n">${money(t.chapters[ci].subchapters[si])}</td></tr>` : "")).join("")}
    <tr class="grand"><td>סה"כ</td><td class="n">${money(t.total)} ₪</td></tr></tbody></table>` : "";
  return `<style>${DOC_CSS}</style>
    <header><div><div class="co">${COMPANY}</div><h1>${prices ? "אומדן עלות שיקום" : "כתב כמויות"}</h1><div>${esc(q.title)}</div></div>
    <div class="meta">${q.projectNo ? `תיק ${esc(q.projectNo)}<br>` : ""}${day}</div></header>
    ${body}${summary}
    <footer>${prices && t.unpriced ? `${t.unpriced} סעיפים ללא מחיר. ` : ""}הופק מהאפליקציה של שפיר.</footer>`;
}

// ---------- validation for quotes received over HTTP ----------

export const LIMITS = Object.freeze({ chapters: 99, subchapters: 99, items: 3000, text: 5000, title: 300 });

const str = (v, max, what) => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new TypeError(`${what} חייב להיות טקסט`);
  if (v.length > max) throw new RangeError(`${what} ארוך מדי`);
  return v;
};
const num = (v, what, { int = false, max = 1e12 } = {}) => {
  const n = v === undefined || v === null || v === "" ? 0 : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max || (int && !Number.isInteger(n))) throw new RangeError(`${what} לא תקין`);
  return n;
};

/** Validate and copy only the fields the document uses. Throws TypeError/RangeError with a Hebrew message. */
export function sanitizeQuote(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.chapters)) throw new TypeError("הצעה לא תקינה");
  if (input.chapters.length > LIMITS.chapters) throw new RangeError("יותר מדי פרקים");
  let itemCount = 0;
  const chapters = input.chapters.map(ch => {
    if (!ch || !Array.isArray(ch.subchapters)) throw new TypeError("פרק לא תקין");
    if (ch.subchapters.length > LIMITS.subchapters) throw new RangeError("יותר מדי תתי פרקים");
    return {
      num: num(ch.num, "מספר פרק", { int: true, max: 99 }),
      title: str(ch.title, LIMITS.title, "שם פרק"),
      subchapters: ch.subchapters.map(sub => {
        if (!sub || !Array.isArray(sub.items)) throw new TypeError("תת פרק לא תקין");
        itemCount += sub.items.length;
        if (itemCount > LIMITS.items) throw new RangeError("יותר מדי סעיפים");
        return {
          num: num(sub.num, "מספר תת פרק", { int: true, max: 99 }),
          title: str(sub.title, LIMITS.title, "שם תת פרק"),
          items: sub.items.map(it => {
            if (!it || typeof it !== "object") throw new TypeError("סעיף לא תקין");
            const code = str(it.code, 12, "קוד סעיף");
            return {
              code: /^\d{9}$/.test(code) ? code : undefined,
              unit: str(it.unit, 10, "יחידה"),
              qty: num(it.qty, "כמות", { max: 999999.99 }),
              price: num(it.price, "מחיר", { max: 999999999.99 }),
              description: str(it.description, LIMITS.text, "תאור"),
            };
          }),
        };
      }),
    };
  });
  return { title: str(input.title, LIMITS.title, "כותרת"), projectNo: num(input.projectNo, "מספר תיק", { int: true, max: 99999999999999 }), chapters };
}
