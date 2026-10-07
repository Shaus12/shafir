// The quote as a printable A4 document, with or without prices, printed by the phone's own
// engine (save as PDF / share), plus a helper that hands any file to the share sheet.

import { quoteTotals, unitLabel } from "../src/skn/model.mjs";

const COMPANY = 'שפיר - שיקום נזקים בע"מ';

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = n => n.toLocaleString("he-IL", { maximumFractionDigits: 2 });
const two = n => String(n).padStart(2, "0");

export const itemLabel = (ch, sub, it, index) =>
  it.code ? `${it.code.slice(2, 4)}.${it.code.slice(4, 6)}.${it.code.slice(6)}` : `${two(ch.num)}.${two(sub.num)}.${String(index + 1).padStart(3, "0")}*`;

const DOC_CSS = `
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

/** Build the document element. `prices: false` leaves out unit prices, line totals and sums. */
export function quoteDocument(q, { prices }) {
  const t = quoteTotals(q);
  const date = new Date().toLocaleDateString("he-IL");
  let body = "";
  q.chapters.forEach((ch, ci) => {
    const subs = ch.subchapters.filter(s => s.items.length);
    if (!subs.length) return;
    body += `<h2>פרק ${two(ch.num)} - ${esc(ch.title)}</h2>`;
    ch.subchapters.forEach((sub, si) => {
      if (!sub.items.length) return;
      const rows = sub.items.map((it, ii) => `<tr><td class="c">${itemLabel(ch, sub, it, ii)}</td><td>${esc(it.description)}</td><td class="c">${esc(unitLabel(it.unit))}</td><td class="n">${qtyFmt(it.qty)}</td>${prices ? `<td class="n">${money(it.price)}</td><td class="n">${money(it.qty * it.price)}</td>` : ""}</tr>`).join("");
      body += `<table><thead><tr><th colspan="${prices ? 6 : 4}">תת פרק ${two(sub.num)} - ${esc(sub.title)}</th></tr>
        <tr><th>סעיף</th><th>תאור</th><th>יחידה</th><th class="n">כמות</th>${prices ? `<th class="n">מחיר יחידה</th><th class="n">סה"כ</th>` : ""}</tr></thead>
        <tbody>${rows}${prices ? `<tr class="sub"><td colspan="5">סה"כ תת פרק ${two(sub.num)}</td><td class="n">${money(t.chapters[ci].subchapters[si])}</td></tr>` : ""}</tbody></table>`;
    });
  });
  const summary = prices ? `<table class="summary"><tbody>${q.chapters.flatMap((ch, ci) => ch.subchapters.map((s, si) => s.items.length ? `<tr><td>${two(ch.num)}.${two(s.num)} ${esc(s.title)}</td><td class="n">${money(t.chapters[ci].subchapters[si])}</td></tr>` : "")).join("")}
    <tr class="grand"><td>סה"כ</td><td class="n">${money(t.total)} ₪</td></tr></tbody></table>` : "";
  const el = document.createElement("div");
  el.className = "pdfdoc";
  el.innerHTML = `<style>${DOC_CSS}</style>
    <header><div><div class="co">${COMPANY}</div><h1>${prices ? "אומדן עלות שיקום" : "כתב כמויות"}</h1><div>${esc(q.title)}</div></div>
    <div class="meta">${q.projectNo ? `תיק ${q.projectNo}<br>` : ""}${date}</div></header>
    ${body}${summary}
    <footer>${prices && t.unpriced ? `${t.unpriced} סעיפים ללא מחיר. ` : ""}הופק מהאפליקציה של שפיר.</footer>`;
  return el;
}

/**
 * Print the quote with the phone's own engine: the print sheet saves it as PDF or shares it (WhatsApp, mail).
 * Browser printing keeps Hebrew as real, correctly ordered text, which canvas-based PDF libraries do not.
 */
export async function printQuote(q, { prices }) {
  const root = document.getElementById("print-root");
  await document.fonts.ready;
  root.replaceChildren(quoteDocument(q, { prices }));
  const title = document.title;
  document.title = (q.title || "הצעת מחיר").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) + (prices ? "" : " - כתב כמויות");
  const restore = () => { document.title = title; root.replaceChildren(); window.removeEventListener("afterprint", restore); };
  window.addEventListener("afterprint", restore);
  window.print();
}

/** Hand a file to the phone's share sheet (WhatsApp, mail…), or download it where sharing files is not supported. */
export async function shareFile(blob, filename, type) {
  const file = new File([blob], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return "downloaded";
}
