import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkn, serializeSkn, entries, items, totals, setPrice, setQty, buildSkn, DESC_WIDTH } from "../src/skn/skn.mjs";
import { encode1255, decode1255, SknEncodingError } from "../src/skn/codec.mjs";

// Real files from Shapir live in samples/skn (git-ignored: client names and addresses).
const SAMPLES = new URL("../samples/skn/", import.meta.url).pathname;
const samples = existsSync(SAMPLES) ? readdirSync(SAMPLES).filter(f => f.endsWith(".skn")) : [];
const read = f => readFileSync(join(SAMPLES, f));
const lineWidths = bytes => new Set(decode1255(bytes).split(/\r?\n/).filter(Boolean).map(l => l.length));

test("codec round-trips Hebrew, quotes and the shekel sign", () => {
  const s = 'פירוק ופינוי 2.5 מ"ר ₪';
  assert.equal(decode1255(encode1255(s)), s);
});

test("codec refuses characters windows-1255 cannot hold", () => {
  assert.throws(() => encode1255("צבע 🎨"), SknEncodingError);
});

for (const f of samples) {
  test(`round-trip is byte-exact: ${f}`, () => {
    const bytes = read(f);
    assert.deepEqual(Buffer.from(serializeSkn(parseSkn(bytes))), bytes);
  });
}

test("engineer files: quantities without prices", { skip: !samples.includes("66021.skn") }, () => {
  const doc = parseSkn(read("66021.skn"));
  const its = items(doc);
  assert.equal(its.length, 42);
  assert.ok(its.every(i => i.price === 0));
  assert.equal(entries(doc)[0].projectNo, 66021);
  assert.equal(totals(doc).unpriced, 42);
});

test("wrapped descriptions are joined back into one sentence", { skip: !samples.includes("66021.skn") }, () => {
  const asbestos = items(parseSkn(read("66021.skn"))).find(i => i.code === "010101010");
  assert.match(asbestos.description, /איסוף שברי אסבסט/);
  assert.match(asbestos.description, /\( מדוד לפי שטח הגג האופקי\)$/);
});

test("Shapir's own file: priced, total matches", { skip: !samples.some(f => f.startsWith("מיריים")) }, () => {
  const doc = parseSkn(read(samples.find(f => f.startsWith("מיריים"))));
  assert.equal(doc.codeWidth, 8);
  assert.equal(doc.align, "left");
  assert.equal(totals(doc).total, 400980);
  assert.equal(totals(doc).unpriced, 0);
});

test("setPrice rewrites only the price column of that one line", { skip: !samples.includes("66132.skn") }, () => {
  const bytes = read("66132.skn");
  const doc = parseSkn(bytes);
  const target = items(doc)[3];
  setPrice(doc, target.code, 1234.5);
  const out = Buffer.from(serializeSkn(doc));
  assert.equal(out.length, bytes.length);
  const diff = [...out].map((b, i) => (b !== bytes[i] ? i : -1)).filter(i => i >= 0);
  assert.ok(diff.length > 0 && diff.length <= 12, `changed ${diff.length} bytes`);
  const again = items(parseSkn(out)).find(i => i.code === target.code);
  assert.equal(again.price, 1234.5);
  assert.equal(again.total, Math.round(target.qty * 1234.5 * 100) / 100);
});

test("setPrice and setQty validate their input", () => {
  const doc = buildSkn({ title: "בדיקה", chapters: [{ title: "שיקום", subchapters: [{ num: 11, title: "עבודות צבע", items: [{ unit: "03", qty: 10, description: "צבע" }] }] }] });
  assert.throws(() => setPrice(doc, "010111001", -1), RangeError);
  assert.throws(() => setPrice(doc, "010111001", Number.NaN), RangeError);
  assert.throws(() => setQty(doc, "010111001", 1e7), RangeError);
  assert.throws(() => setPrice(doc, "019999999", 5), /No item/);
});

test("buildSkn writes a file Binarit's layout rules accept and that reads back the same", () => {
  const long = "אספקה והתקנה של נקודת מאור מושלמת הכולל וו תליה, פנדל, בית נורה וגוף תאורה 100 ווט ו/או שווה ערך כולל חיווט במוליכי נחושת מבודדים פי.וי.סי 2.5 מ\"ר מושחלים בצנרת מותקנת";
  const spec = {
    projectNo: 70001,
    title: "ישראל ישראלי - הרצל 1 אשקלון",
    chapters: [{
      title: "אומדן עלות שיקום מבנה לאחר נזק מים",
      subchapters: [
        { num: 1, title: "עבודות פרוק והריסה", items: [{ unit: "03", qty: 96, price: 35, description: "ניקוי ושאיבת הבוצה מהבית" }] },
        { num: 8, title: "עבודות חשמל", items: [{ unit: "01", qty: 12, price: 280, description: long }] },
      ],
    }],
  };
  for (const eol of ["\r\n", "\n"]) {
    const bytes = serializeSkn(buildSkn({ ...spec, eol }));
    assert.deepEqual(lineWidths(bytes), new Set([32 + DESC_WIDTH]));
    const doc = parseSkn(bytes);
    assert.equal(doc.eol, eol);
    assert.deepEqual(Buffer.from(serializeSkn(doc)), Buffer.from(bytes));
    const its = items(doc);
    assert.deepEqual(its.map(i => [i.code, i.unit, i.qty, i.price]), [["010101001", "03", 96, 35], ["010108001", "01", 12, 280]]);
    assert.equal(its[1].description, long);
    assert.equal(entries(doc)[0].projectNo, 70001);
    assert.equal(totals(doc).total, 96 * 35 + 12 * 280);
    assert.deepEqual(entries(doc).filter(e => e.level === "subchapter").map(e => e.description), ["תת פרק 01 עבודות פרוק והריסה", "תת פרק 08 עבודות חשמל"]);
  }
});

test("buildSkn rejects bad input at the boundary", () => {
  const base = { title: "x", chapters: [{ title: "y", subchapters: [{ num: 1, title: "z", items: [{ unit: "03", qty: 1, description: "d" }] }] }] };
  assert.throws(() => buildSkn({ ...base, title: " " }), /title/);
  assert.throws(() => buildSkn({ ...base, chapters: [] }), /chapter/);
  assert.throws(() => buildSkn({ ...base, chapters: [{ title: "y", subchapters: [{ num: 100, title: "z", items: [] }] }] }), RangeError);
  assert.throws(() => buildSkn({ ...base, chapters: [{ title: "y", subchapters: [{ num: 1, title: "z", items: [{ unit: "m2", qty: 1, description: "d" }] }] }] }), /unit/);
  assert.throws(() => serializeSkn(buildSkn({ ...base, title: "emoji 🔥" })), SknEncodingError);
});
