import { test, after } from "node:test";
import assert from "node:assert/strict";
import { quoteDocumentHtml, sanitizeQuote, quoteFileBase, LIMITS } from "../src/quote-document.mjs";
import handler, { pdfPageHtml, renderPdf, closeBrowser } from "../api/pdf.mjs";

// Real render tests need a local Chrome: CHROME_PATH=/path/to/chrome npm test
const HAVE_CHROME = Boolean(process.env.CHROME_PATH);

const QUOTE = {
  title: 'ישראל ישראלי - הרצל 1 אשקלון <b>',
  projectNo: 66021,
  chapters: [{ num: 1, title: "אומדן עלות שיקום", subchapters: [
    { num: 1, title: "עבודות פרוק והריסה", items: [{ code: "010101001", unit: "09", qty: 1, price: 1250, description: "פרוק מערכת חשמל / מתח נמוך כמפורט בפרק 08" }] },
    { num: 11, title: "עבודות צבע", items: [{ unit: "03", qty: 120, price: 38, description: 'צביעת קירות ותקרות בסופרקריל, ס"מ' }] },
  ] }],
};

function call(req) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(body) { resolve({ status: this.statusCode, headers: this.headers, body }); },
    };
    handler({ method: "POST", headers: {}, body: {}, ...req }, res);
  });
}

test("document HTML escapes user text and hides prices on request", () => {
  const withPrices = quoteDocumentHtml(QUOTE, { prices: true, date: new Date("2026-10-18T22:30:00Z") });
  assert.match(withPrices, /&lt;b&gt;/);
  assert.doesNotMatch(withPrices, /<b>/);
  assert.match(withPrices, /5,810\.00 ₪/);
  assert.match(withPrices, /19\.10\.2026/, "date is Israel time, not UTC");
  const noPrices = quoteDocumentHtml(QUOTE, { prices: false });
  assert.doesNotMatch(noPrices, /מחיר יחידה|1,250/);
  assert.match(noPrices, /כתב כמויות/);
  assert.equal(quoteFileBase(QUOTE, { prices: false }), "ישראל ישראלי - הרצל 1 אשקלון  b - כתב כמויות");
});

test("sanitizeQuote keeps only document fields and rejects bad input", () => {
  const clean = sanitizeQuote({ ...QUOTE, extra: "x", chapters: [{ ...QUOTE.chapters[0], junk: 1 }] });
  assert.deepEqual(Object.keys(clean), ["title", "projectNo", "chapters"]);
  assert.equal(clean.chapters[0].subchapters[1].items[0].code, undefined);
  assert.throws(() => sanitizeQuote(null), TypeError);
  assert.throws(() => sanitizeQuote({ chapters: "x" }), TypeError);
  const bad = item => ({ chapters: [{ num: 1, title: "", subchapters: [{ num: 1, title: "", items: [item] }] }] });
  assert.throws(() => sanitizeQuote(bad({ qty: -1 })), RangeError);
  assert.throws(() => sanitizeQuote(bad({ price: "abc" })), RangeError);
  assert.throws(() => sanitizeQuote(bad({ description: "x".repeat(LIMITS.text + 1) })), RangeError);
  const many = { chapters: [{ num: 1, title: "", subchapters: [{ num: 1, title: "", items: Array.from({ length: LIMITS.items + 1 }, () => ({})) }] }] };
  assert.throws(() => sanitizeQuote(many), /יותר מדי סעיפים/);
});

test("the PDF page embeds its fonts and loads nothing from outside", () => {
  const html = pdfPageHtml(QUOTE, { prices: true });
  assert.equal((html.match(/@font-face/g) || []).length, 6);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("API refuses wrong methods, missing or wrong access codes, and bad quotes", async () => {
  delete process.env.ACCESS_CODE;
  const unconfigured = await call({ headers: { "x-access-code": "" }, body: { quote: QUOTE } });
  assert.equal(unconfigured.status, 503, "a missing server code is a setup problem, not a wrong code");
  process.env.ACCESS_CODE = "test-code";
  assert.equal((await call({ method: "GET" })).status, 405);
  assert.equal((await call({ body: { quote: QUOTE } })).status, 401);
  assert.equal((await call({ headers: { "x-access-code": "nope" }, body: { quote: QUOTE } })).status, 401);
  const bad = await call({ headers: { "x-access-code": "test-code" }, body: { quote: { chapters: 5 } } });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /הצעה לא תקינה/);
});

test("API returns a real PDF", { skip: !HAVE_CHROME && "set CHROME_PATH to run" }, async () => {
  process.env.ACCESS_CODE = "test-code";
  const r = await call({ headers: { "x-access-code": "test-code" }, body: { quote: QUOTE, prices: true } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/pdf");
  assert.match(r.headers["content-disposition"], /filename\*=UTF-8''/);
  assert.equal(r.body.subarray(0, 5).toString(), "%PDF-");
});

test("renders a no-prices PDF with the warm browser", { skip: !HAVE_CHROME && "set CHROME_PATH to run" }, async () => {
  const pdf = await renderPdf(QUOTE, { prices: false });
  assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), "%PDF-");
});

after(closeBrowser);
