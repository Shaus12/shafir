// The quote as a printable A4 document, with or without prices: printed by the browser on desktop,
// or rendered to a PDF file on phones (where printing is missing in in-app browsers), plus a helper
// that hands any file to the share sheet or downloads it.

import { quoteTotals, unitLabel, itemLabel } from "../src/skn/model.mjs";
import { wrapText, jpegPagesToPdf } from "../src/pdf-writer.mjs";

const COMPANY = 'שפיר - שיקום נזקים בע"מ';

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = n => n.toLocaleString("he-IL", { maximumFractionDigits: 2 });
const two = n => String(n).padStart(2, "0");

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

const UA = typeof navigator === "undefined" ? "" : navigator.userAgent;

/** Phones and tablets, including iPadOS which reports a desktop Safari user agent. */
export function isMobileDevice() {
  return Boolean(navigator.userAgentData?.mobile)
    || /Android|iPhone|iPad|iPod|Mobi/i.test(UA)
    || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
}

/** Android WebViews and in-app browsers (WhatsApp, Facebook, Instagram), where downloads often do nothing. */
export function isInAppBrowser() {
  return /; wv\)|WhatsApp|FBAN|FBAV|Instagram/i.test(UA);
}

/** Download through a temporary <a download>. The object URL lives long enough for slow download managers. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

/**
 * Hand a file to the share sheet (WhatsApp, mail, Files…), or download it where sharing files is not
 * supported or not allowed. Must be called while the user's tap is still active. Returns
 * "shared", "cancelled" (the user closed the share sheet) or "downloaded".
 */
export async function shareFile(blob, filename, type) {
  const file = new File([blob], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  return downloadBlob(blob, filename);
}

/* ---------- PDF file (phones) ---------- */

const PAGE_W = 794;
const PAGE_H = 1123;
const MARGIN = 40;
const SCALE = 2;
const FONT_FAMILY = '"IBM Plex Sans Hebrew", Arial, sans-serif';
const COLORS = { text: "#1c2220", muted: "#4a5451", line: "#dfe3e1", th: "#9aa3a0", band: "#eceeed" };
const SIZE = { body: 13.3, small: 11.3, h2: 14.7, h1: 17.3, company: 20, grand: 16 };
const font = (size, weight = 400) => `${weight} ${size}px ${FONT_FAMILY}`;

/** Lay the quote out on A4 pages, the same content as the printed document. Returns draw operations per page. */
function layoutQuote(ctx, q, prices) {
  const t = quoteTotals(q);
  const L = MARGIN, R = PAGE_W - MARGIN, W = R - L, top = MARGIN, bottom = PAGE_H - MARGIN;
  const lineH = SIZE.body * 1.45;
  const thH = SIZE.small * 1.45 + 6;
  const pages = [];
  let ops, y;

  const newPage = () => { ops = []; pages.push(ops); y = top; };
  const text = (str, x, yy, { size = SIZE.body, weight = 400, color = COLORS.text, align = "right", dir = "rtl" } = {}) =>
    ops.push(c => { c.font = font(size, weight); c.fillStyle = color; c.direction = dir; c.textAlign = align; c.textBaseline = "top"; c.fillText(str, x, yy); });
  const rule = (x1, x2, yy, color, width = 1) =>
    ops.push(c => { c.strokeStyle = color; c.lineWidth = width; c.beginPath(); c.moveTo(x1, yy); c.lineTo(x2, yy); c.stroke(); });
  const band = (yy, h) => ops.push(c => { c.fillStyle = COLORS.band; c.fillRect(L, yy, W, h); });
  const fits = h => y + h <= bottom;

  newPage();
  text(COMPANY, R, y, { size: SIZE.company, weight: 700 });
  text(prices ? "אומדן עלות שיקום" : "כתב כמויות", R, y + 30, { size: SIZE.h1, weight: 700 });
  let headerY = y + 56;
  for (const line of q.title ? wrapText(ctx, q.title, W * 0.65, font(SIZE.body)) : []) {
    text(line, R, headerY);
    headerY += lineH;
  }
  const meta = [q.projectNo ? `תיק ${q.projectNo}` : "", new Date().toLocaleDateString("he-IL")].filter(Boolean);
  meta.forEach((line, i) => text(line, L, y + 30 + i * 17, { size: 12, color: COLORS.muted, align: "left" }));
  y = Math.max(headerY, y + 30 + meta.length * 17) + 8;
  rule(L, R, y, COLORS.text, 2);
  y += 12;

  const spec = prices
    ? [["סעיף", 72, "c"], ["תאור", 0, "t"], ["יחידה", 52, "c"], ["כמות", 62, "n"], ["מחיר יחידה", 84, "n"], ['סה"כ', 92, "n"]]
    : [["סעיף", 72, "c"], ["תאור", 0, "t"], ["יחידה", 52, "c"], ["כמות", 72, "n"]];
  const fixed = spec.reduce((sum, [, width]) => sum + width, 0);
  let edge = R;
  const cols = spec.map(([label, width, kind]) => {
    const w = width || W - fixed;
    const col = { label, kind, right: edge, left: edge - w, width: w };
    edge -= w;
    return col;
  });
  const descCol = cols[1];
  const cell = (col, value, yy, options = {}) => col.kind === "n"
    ? text(value, col.left + 4, yy, { align: "left", dir: "ltr", ...options })
    : text(value, col.right - 4, yy, options);

  const thead = title => {
    text(title, R - 4, y + 3, { size: SIZE.small, weight: 600, color: COLORS.muted });
    y += thH;
    rule(L, R, y, COLORS.th);
    for (const col of cols) cell(col, col.label, y + 3, { size: SIZE.small, weight: 600, color: COLORS.muted });
    y += thH;
    rule(L, R, y, COLORS.th);
  };

  q.chapters.forEach((ch, ci) => {
    if (!ch.subchapters.some(s => s.items.length)) return;
    const h2H = SIZE.h2 * 1.45 + 8;
    if (!fits(14 + h2H + 6 + 2 * thH + lineH + 8)) newPage();
    if (y > top) y += 14;
    band(y, h2H);
    text(`פרק ${two(ch.num)} - ${ch.title}`, R - 8, y + 4, { size: SIZE.h2, weight: 700 });
    y += h2H + 6;

    ch.subchapters.forEach((sub, si) => {
      if (!sub.items.length) return;
      const title = `תת פרק ${two(sub.num)} - ${sub.title}`;
      const rows = sub.items.map((it, ii) => {
        const lines = wrapText(ctx, it.description, descCol.width - 8, font(SIZE.body));
        return { it, ii, lines, h: lines.length * lineH + 8 };
      });
      if (!fits(2 * thH + rows[0].h)) newPage();
      thead(title);
      for (const { it, ii, lines, h } of rows) {
        if (!fits(h)) { newPage(); thead(title); }
        cell(cols[0], itemLabel(ch, sub, it, ii), y + 5, { size: SIZE.small, color: COLORS.muted });
        lines.forEach((line, li) => cell(descCol, line, y + 4 + li * lineH));
        cell(cols[2], unitLabel(it.unit), y + 5, { size: SIZE.small, color: COLORS.muted });
        cell(cols[3], qtyFmt(it.qty), y + 4);
        if (prices) {
          cell(cols[4], money(it.price), y + 4);
          cell(cols[5], money(it.qty * it.price), y + 4);
        }
        y += h;
        rule(L, R, y, COLORS.line);
      }
      if (prices) {
        const h = lineH + 8;
        if (!fits(h)) { newPage(); thead(title); }
        text(`סה"כ תת פרק ${two(sub.num)}`, R - 4, y + 4, { weight: 700 });
        cell(cols[5], money(t.chapters[ci].subchapters[si]), y + 4, { weight: 700 });
        y += h;
        rule(L, R, y, COLORS.text, 1.5);
      }
      y += 4;
    });
  });

  if (prices) {
    const sumR = L + W * 0.6;
    const rowH = lineH + 8;
    y += 16;
    q.chapters.forEach((ch, ci) => ch.subchapters.forEach((s, si) => {
      if (!s.items.length) return;
      if (!fits(rowH)) newPage();
      text(`${two(ch.num)}.${two(s.num)} ${s.title}`, sumR - 4, y + 4);
      text(money(t.chapters[ci].subchapters[si]), L + 4, y + 4, { align: "left", dir: "ltr" });
      y += rowH;
      rule(L, sumR, y, COLORS.line);
    }));
    const grandH = SIZE.grand * 1.45 + 8;
    if (!fits(grandH)) newPage();
    rule(L, sumR, y, COLORS.text, 2);
    text('סה"כ', sumR - 4, y + 4, { size: SIZE.grand, weight: 700 });
    text(`${money(t.total)} ₪`, L + 4, y + 4, { size: SIZE.grand, weight: 700, align: "left", dir: "ltr" });
    y += grandH;
  }

  const footer = `${prices && t.unpriced ? `${t.unpriced} סעיפים ללא מחיר. ` : ""}הופק מהאפליקציה של שפיר.`;
  if (!fits(18 + SIZE.small * 1.45)) newPage();
  y += 18;
  text(footer, R, y, { size: SIZE.small, color: COLORS.muted });

  return pages;
}

const canvasToJpeg = canvas => new Promise((resolve, reject) => {
  canvas.toBlob(blob => blob ? blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject) : reject(new Error("יצירת ה-PDF נכשלה")), "image/jpeg", 0.88);
});

/**
 * Render the quote to a PDF file in the browser, for phones. Pages are drawn on a canvas, which keeps
 * Hebrew correctly ordered, and embedded as images; one canvas is reused so memory stays flat.
 */
export async function quotePdfBlob(q, { prices }) {
  await document.fonts.ready;
  await Promise.all([400, 600, 700].map(weight => document.fonts.load(font(SIZE.body, weight)).catch(() => null)));
  const canvas = document.createElement("canvas");
  canvas.width = PAGE_W * SCALE;
  canvas.height = PAGE_H * SCALE;
  const ctx = canvas.getContext("2d");
  const pages = layoutQuote(ctx, q, prices);
  const images = [];
  for (const ops of pages) {
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    for (const op of ops) op(ctx);
    images.push(await canvasToJpeg(canvas));
  }
  const blob = jpegPagesToPdf(images, canvas.width, canvas.height);
  canvas.width = canvas.height = 0;
  return blob;
}
