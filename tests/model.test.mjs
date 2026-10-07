import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sknToQuote, quoteToSkn, quoteTotals, parseAmount } from "../src/skn/model.mjs";
import { parseSkn, items, totals } from "../src/skn/skn.mjs";

const SAMPLES = new URL("../samples/skn/", import.meta.url).pathname;
const samples = existsSync(SAMPLES) ? readdirSync(SAMPLES).filter(f => f.endsWith(".skn")) : [];

for (const f of samples) {
  test(`SKN → quote → SKN keeps every item, quantity, price and description: ${f}`, () => {
    const original = parseSkn(readFileSync(join(SAMPLES, f)));
    const quote = sknToQuote(readFileSync(join(SAMPLES, f)));
    const again = parseSkn(quoteToSkn(quote));
    const shape = its => its.map(i => [i.unit, i.qty, i.price, i.description]);
    assert.deepEqual(shape(items(again)), shape(items(original)));
    assert.equal(totals(again).total, totals(original).total);
    assert.equal(quoteTotals(quote).total, totals(original).total);
  });
}

test("engineer codes survive; headings lose their numbering prefixes", { skip: !samples.includes("66021.skn") }, () => {
  const quote = sknToQuote(readFileSync(join(SAMPLES, "66021.skn")));
  assert.equal(quote.projectNo, 66021);
  assert.equal(quote.chapters[0].title, "אומדן עלות שיקום מבנה לאחר ארוע שריפה");
  assert.equal(quote.chapters[0].subchapters[0].title, "עבודות פרוק והריסה");
  const codes = items(parseSkn(quoteToSkn(quote))).map(i => i.code);
  assert.deepEqual(codes, items(parseSkn(readFileSync(join(SAMPLES, "66021.skn")))).map(i => i.code));
});

test("items added in the app get free codes next to the engineer's", () => {
  const quote = {
    title: "בדיקה", projectNo: 5,
    chapters: [{ num: 1, title: "שיקום", subchapters: [{ num: 11, title: "עבודות צבע", items: [
      { code: "010111001", unit: "03", qty: 10, price: 40, description: "צבע קירות" },
      { unit: "03", qty: 5, price: 50, description: "צבע תקרה" },
      { code: "010111002", unit: "01", qty: 1, price: 300, description: "צבע דלת" },
    ] }] }],
  };
  const codes = items(parseSkn(quoteToSkn(quote))).map(i => i.code);
  assert.deepEqual(codes, ["010111001", "010111003", "010111002"]);
  assert.deepEqual(quoteTotals(quote), { total: 950, chapters: [{ total: 950, subchapters: [950] }], unpriced: 0, count: 3 });
});

test("parseAmount accepts what people type on a phone and rejects the rest", () => {
  assert.equal(parseAmount("1,250", "price"), 1250);
  assert.equal(parseAmount("₪ 99.999", "price"), 100);
  assert.equal(parseAmount("12.5", "qty"), 12.5);
  assert.throws(() => parseAmount("-3", "qty"), RangeError);
  assert.throws(() => parseAmount("abc", "price"), RangeError);
  assert.throws(() => parseAmount("1000000", "qty"), RangeError);
});

test("an empty quote cannot be exported", () => {
  assert.throws(() => quoteToSkn({ title: "x", chapters: [{ num: 1, title: "y", subchapters: [{ num: 1, title: "z", items: [] }] }] }), /אין סעיפים/);
});
