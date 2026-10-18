// POST /api/pdf  { quote, prices }  →  application/pdf
// Renders the quote with headless Chromium, so Hebrew comes out as real, correctly ordered text
// on any phone (Android cannot print from home-screen apps or WhatsApp's browser).
// The page gets no network and the fonts are embedded, so the output does not depend on anything outside.

import { readFileSync } from "node:fs";
import { quoteDocumentHtml, sanitizeQuote, quoteFileBase } from "../src/quote-document.mjs";

const FONT_DIR = new URL("../src/fonts/", import.meta.url);
const HEBREW_RANGE = "U+0307-0308,U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F";
const LATIN_RANGE = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

let fontCss = null;
function fonts() {
  if (fontCss) return fontCss;
  fontCss = "";
  for (const [subset, range] of [["hebrew", HEBREW_RANGE], ["latin", LATIN_RANGE]]) {
    for (const weight of [400, 600, 700]) {
      const data = readFileSync(new URL(`plex-${subset}-${weight}.woff2`, FONT_DIR)).toString("base64");
      fontCss += `@font-face{font-family:"IBM Plex Sans Hebrew";font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:${range}}`;
    }
  }
  return fontCss;
}

export function pdfPageHtml(quote, { prices, date }) {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>${fonts()}
@page{size:A4;margin:10mm 10mm 12mm}html,body{margin:0;background:#fff}</style></head>
<body><div class="pdfdoc">${quoteDocumentHtml(quote, { prices, date })}</div></body></html>`;
}

// One browser per warm function instance; a fresh page per request.
let browserPromise = null;
async function browser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b?.connected) return b;
  }
  browserPromise = (async () => {
    const puppeteer = (await import("puppeteer-core")).default;
    if (process.env.CHROME_PATH) {
      // Local development: any installed Chrome/Chromium.
      return puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    }
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
  })();
  return browserPromise;
}

/** Close the warm browser (tests, local scripts). */
export async function closeBrowser() {
  const b = await browserPromise?.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => {});
}

export async function renderPdf(quote, { prices, date }) {
  const page = await (await browser()).newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", r => (r.url().startsWith("data:") || r.url() === "about:blank" ? r.continue() : r.abort()));
    await page.setContent(pdfPageHtml(quote, { prices, date }), { waitUntil: "load", timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    return await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true });
  } finally {
    await page.close().catch(() => {});
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "שיטת הבקשה אינה נתמכת." });
  }
  if (!process.env.ACCESS_CODE) {
    return sendJson(res, 503, { error: "יצירת PDF בשרת עוד לא הוגדרה (חסר קוד גישה בשרת)." });
  }
  if (req.headers["x-access-code"] !== process.env.ACCESS_CODE) {
    return sendJson(res, 401, { error: "קוד הגישה שגוי." });
  }
  let quote;
  try {
    quote = sanitizeQuote(req.body?.quote);
  } catch (e) {
    return sendJson(res, 400, { error: e.message || "הצעה לא תקינה." });
  }
  const prices = req.body?.prices !== false;
  try {
    const pdf = await renderPdf(quote, { prices, date: new Date() });
    const name = encodeURIComponent(quoteFileBase(quote, { prices }) + ".pdf");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="quote.pdf"; filename*=UTF-8''${name}`);
    res.setHeader("Cache-Control", "no-store");
    res.end(Buffer.from(pdf));
  } catch (e) {
    console.error("pdf render failed", e);
    browserPromise = null;
    return sendJson(res, 500, { error: "יצירת ה-PDF נכשלה. נסו שוב." });
  }
}
