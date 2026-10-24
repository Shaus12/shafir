import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildQuotes, extractQuotes, formatQuotesReply, specToQuote, numbersIn, resolveQuantity, normalizeDimensions,
  HOUSE, CHAPTER, ADDON_SOOT_SUCTION, ADDON_GENERAL_CLEAN,
} from "../src/quote-engine.mjs";
import { parseQuotesReply, findLastQuotes } from "../src/items-history.mjs";
import { quoteToSkn, sknToQuote } from "../src/skn/model.mjs";
import { quoteToXlsx } from "../src/xlsx.mjs";

const TEXT = `שמעון התרסי 20 תל אביב רכוש משותף
נקיון ונטרול פיח קומת כניסה, גרם מדרגות 4 קומות
צביעת הנ"ל במספר שכבות גוון לבן עד לקבלת גוון אחיד ומושלם 5 יחידות
נקיון חיפוי שיש 5 יחידות
נקיון ארונות מתכת 2 יחידות בקומה 3 יחידות
נקיון וצביעת דלת מעלית 2 יחידות
קרצוף רצפה כולל מבואת כניסה 5 יחידות
דירה 12 צד ג'
פירוק אספקה והתקנת חלון אלומיניום זכוכית בלבד במידות 2.42 על 2.170
ניקיון ונטרול פיח 50 מטר מרובע צביעה של קירות ותקרת המבנה 50 מטר מרובע צבע דלתות שלוש יחידות ניקיון צמודי מבנה החלפת מזגן שתיים וחצי כוח סוס בסלון החלפת מזגן אחד ורבע כוח סוס בחדר שינה פרקט ברצפת המבנה 45 מ"ר
מבואת דירות החלפת פרקט 8 מ"ר
נטרול פיח וצביעת מבואת דירות`;

const item = (kind, fields = {}) => ({
  kind, text: "", description: "", subject: "", location: "", color: "", singular_noun: false, room: "", hp: null, hp_source: "", unit: "01",
  quantity_parts: [], quantity_source: "", leftover: "", ...fields,
});

// What a model that follows the prompt returns for TEXT (the model call itself is not part of these tests).
const MODEL_ANSWER = {
  quotes: [
    {
      address: "שמעון התרסי 20 תל אביב", party_kind: "common_property", party_label: "רכוש משותף",
      items: [
        item("soot_clean", { text: "נקיון ונטרול פיח קומת כניסה, גרם מדרגות 4 קומות", location: "בקומת כניסה ובגרם מדרגות 4 קומות" }),
        item("paint_after_soot", { text: 'צביעת הנ"ל במספר שכבות גוון לבן עד לקבלת גוון אחיד ומושלם 5 יחידות', color: "לבן", quantity_parts: [5], quantity_source: "5 יחידות" }),
        item("other", { text: "נקיון חיפוי שיש 5 יחידות", description: "נקיון חיפוי שיש", quantity_parts: [5], quantity_source: "5 יחידות" }),
        item("other", { text: "נקיון ארונות מתכת 2 יחידות בקומה 3 יחידות", description: "נקיון ארונות מתכת", quantity_parts: [2, 3], quantity_source: "2 יחידות בקומה 3 יחידות" }),
        item("other", { text: "נקיון וצביעת דלת מעלית 2 יחידות", description: "נקיון וצביעת דלת מעלית", quantity_parts: [2], quantity_source: "2 יחידות" }),
        item("other", { text: "קרצוף רצפה כולל מבואת כניסה 5 יחידות", description: "קרצוף רצפה כולל מבואת כניסה", quantity_parts: [5], quantity_source: "5 יחידות" }),
      ],
    },
    {
      address: "שמעון התרסי 20 תל אביב", party_kind: "third_party", party_label: "דירה 12 צד ג'",
      items: [
        item("replace", { text: "פירוק אספקה והתקנת חלון אלומיניום זכוכית בלבד במידות 2.42 על 2.170", subject: "חלון אלומיניום זכוכית בלבד במידות 2.42 על 2.170", singular_noun: true }),
        item("soot_clean", { text: "ניקיון ונטרול פיח 50 מטר מרובע", unit: "03", quantity_parts: [50], quantity_source: "50 מטר מרובע" }),
        item("paint_after_soot", { text: "צביעה של קירות ותקרת המבנה 50 מטר מרובע", unit: "03", quantity_parts: [50], quantity_source: "50 מטר מרובע" }),
        item("other", { text: "צבע דלתות שלוש יחידות", description: "צבע דלתות", quantity_parts: [3], quantity_source: "שלוש יחידות" }),
        item("cleaning_attached", { text: "ניקיון צמודי מבנה" }),
        item("ac_replace", { text: "החלפת מזגן שתיים וחצי כוח סוס בסלון", room: "בסלון", hp: 2.5, hp_source: "שתיים וחצי כוח סוס" }),
        item("ac_replace", { text: "החלפת מזגן אחד ורבע כוח סוס בחדר שינה", room: "בחדר שינה", hp: 1.25, hp_source: "אחד ורבע כוח סוס" }),
        item("other", { text: 'פרקט ברצפת המבנה 45 מ"ר', description: "פרקט ברצפת המבנה", unit: "03", quantity_parts: [45], quantity_source: '45 מ"ר' }),
        item("replace", { text: 'מבואת דירות החלפת פרקט 8 מ"ר', subject: "פרקט במבואת דירות", unit: "03", quantity_parts: [8], quantity_source: '8 מ"ר' }),
        item("soot_clean", { text: "נטרול פיח וצביעת מבואת דירות", location: "במבואת דירות" }),
        item("paint_after_soot", { text: "נטרול פיח וצביעת מבואת דירות", location: "במבואת דירות" }),
      ],
    },
  ],
  unplaced: [],
};

const result = buildQuotes(MODEL_ANSWER, TEXT);
const [common, third] = result.quotes;
const byDescription = (quote, part) => quote.items.filter(i => i.description.includes(part));

test("the example becomes two quotes titled by address and party, with the damage-type chapter", () => {
  assert.equal(result.quotes.length, 2);
  assert.equal(common.title, "שמעון התרסי 20 תל אביב רכוש משותף");
  assert.equal(common.chapterTitle, CHAPTER.fire);
  assert.equal(common.subTitle, "עבודות מבנה");
  assert.equal(third.title, "שמעון התרסי 20 תל אביב דירה 12 צד ג'");
  assert.equal(third.chapterTitle, CHAPTER.fire);
  assert.equal(third.subTitle, "דירה 12 צד ג'");
});

test("house wording, units and the quantities stated in the notes", () => {
  assert.equal(common.items[0].description, `${HOUSE.soot} בקומת כניסה ובגרם מדרגות 4 קומות`);
  assert.equal(common.items[0].quantity, null); // no quantity stated for it: stays missing
  assert.equal(common.items[1].description, 'צביעת הנ"ל במספר שכבות בגוון לבן עד לקבלת גוון אחיד ומושלם');
  assert.equal(common.items[1].quantity, 5);
  assert.equal(byDescription(common, "נקיון חיפוי שיש")[0].quantity, 5);
  assert.deepEqual(byDescription(common, "ארונות מתכת").map(i => [i.unit, i.quantity]), [["01", 6]]);
  assert.equal(byDescription(common, "דלת מעלית")[0].quantity, 2);
  assert.equal(byDescription(common, "קרצוף")[0].quantity, 5);

  const soot = third.items.find(i => i.description.startsWith(HOUSE.soot));
  assert.deepEqual([soot.unit, soot.quantity], ["03", 50]);
  const paint = third.items.find(i => i.description === HOUSE.paint);
  assert.deepEqual([paint.unit, paint.quantity], ["03", 50]);
  assert.deepEqual([byDescription(third, "צבע דלתות")[0].unit, byDescription(third, "צבע דלתות")[0].quantity], ["01", 3]);
  assert.deepEqual([byDescription(third, HOUSE.attached)[0].unit, byDescription(third, HOUSE.attached)[0].quantity], ["09", 1]);
  const floor = byDescription(third, "פרקט ברצפת המבנה"); // a bare element: split into removal and installation
  assert.deepEqual(floor.map(i => i.description), ["פרוק ופינוי פרקט ברצפת המבנה", 'או"ה פרקט ברצפת המבנה כדוגמת הקיים']);
  assert.deepEqual(floor.map(i => [i.unit, i.quantity]), [["03", 45], ["03", 45]]);
});

test("replacements are split into removal and installation with the same quantity; dimensions are rewritten", () => {
  const window = third.items.filter(i => i.description.includes("חלון"));
  assert.deepEqual(window.map(i => i.description), [
    "פרוק ופינוי חלון אלומיניום זכוכית בלבד במידות 242/217",
    'או"ה חלון אלומיניום זכוכית בלבד במידות 242/217 כדוגמת הקיים',
  ]);
  assert.deepEqual(window.map(i => [i.unit, i.quantity]), [["01", 1], ["01", 1]]); // singular noun, none stated: one

  const parquet = third.items.filter(i => i.description.includes("פרקט במבואת דירות"));
  assert.deepEqual(parquet.map(i => i.description), ["פרוק ופינוי פרקט במבואת דירות", 'או"ה פרקט במבואת דירות כדוגמת הקיים']);
  assert.deepEqual(parquet.map(i => [i.unit, i.quantity]), [["03", 8], ["03", 8]]);

  const ac = third.items.filter(i => i.description.includes("מזגן")).map(i => i.description);
  assert.deepEqual(ac, [
    "פרוק ופינוי מזגן בסלון",
    'או"ה מזגן מפוצל 2.5 כ"ס בסלון כדוגמת הקיים',
    "פרוק ופינוי מזגן בחדר שינה",
    'או"ה מזגן מפוצל 1.25 כ"ס בחדר שינה כדוגמת הקיים',
  ]);
});

test("the last two lines (מבואת דירות) are present as items or under לא שובץ, never missing", () => {
  const reply = formatQuotesReply(result);
  const sootLast = third.items.filter(i => i.description.startsWith(HOUSE.soot) && i.description.includes("מבואת דירות"));
  const paintLast = third.items.filter(i => i.description.startsWith(HOUSE.paint) && i.description.includes("מבואת דירות"));
  assert.equal(sootLast.length + paintLast.length, 2);
  assert.ok(reply.includes("מבואת דירות"));
  assert.deepEqual(result.unplaced, [], "the stated colour went into the painting item, so nothing is left over");
});

test("a quantity not backed by the original words stays missing and is listed", () => {
  assert.deepEqual(resolveQuantity([5], "5 יחידות", TEXT), { quantity: 5, problem: "" });
  assert.deepEqual(resolveQuantity([2, 3], "2 יחידות בקומה 3 יחידות", TEXT), { quantity: 6, problem: "" });
  assert.equal(resolveQuantity([7], "5 יחידות", TEXT).quantity, null); // part not read from the words
  assert.equal(resolveQuantity([5], "9 יחידות", TEXT).quantity, null); // words not in the message
  assert.deepEqual(resolveQuantity([], "", TEXT), { quantity: null, problem: "" });

  const invented = buildQuotes({ quotes: [{ address: "", party_kind: "other", party_label: "", items: [item("other", { description: "צביעה", quantity_parts: [40], quantity_source: "40 מטר" })] }], unplaced: [] }, "צביעה בלי כמות");
  assert.equal(invented.quotes[0].items[0].quantity, null);
  assert.ok(invented.unplaced.some(entry => entry.startsWith("כמות לא אומתה")));
});

test("numbers in words, fractions and dimensions", () => {
  assert.deepEqual(numbersIn("שתיים וחצי כוח סוס"), [2.5]);
  assert.deepEqual(numbersIn("אחד ורבע"), [1.25]);
  assert.deepEqual(numbersIn("שלוש יחידות"), [3]);
  assert.deepEqual(numbersIn("עשרים וחמש"), [25]);
  assert.deepEqual(numbersIn("2 יחידות בקומה 3 יחידות"), [2, 3]);
  assert.deepEqual(numbersIn("2.5 וחצי"), [3]);
  assert.equal(normalizeDimensions("חלון במידות 2.42 על 2.170"), "חלון במידות 242/217");
  assert.equal(normalizeDimensions("חלון 2.42 על 2.170"), "חלון במידות 242/217");
});

test("items are numbered 010, 020, ... in one chapter and one subchapter, and the SKN and Excel writers take them", () => {
  const quote = specToQuote(common);
  const codes = quote.chapters[0].subchapters[0].items.map(i => i.code);
  assert.deepEqual(codes.slice(0, 3), ["010101010", "010101020", "010101030"]);

  const back = sknToQuote(quoteToSkn(quote));
  assert.equal(back.chapters.length, 1);
  assert.equal(back.chapters[0].title, CHAPTER.fire);
  assert.equal(back.chapters[0].subchapters[0].title, "עבודות מבנה");
  assert.deepEqual(back.chapters[0].subchapters[0].items.map(i => i.code), codes);
  assert.equal(back.chapters[0].subchapters[0].items[3].qty, 6);
  assert.equal(back.chapters[0].subchapters[0].items[3].description, common.items[3].description);

  const thirdBack = sknToQuote(quoteToSkn(specToQuote(third)));
  assert.equal(thirdBack.chapters[0].subchapters[0].title, "דירה 12 צד ג'");
  assert.ok(thirdBack.chapters[0].subchapters[0].items.some(i => i.description.includes('או"ה מזגן מפוצל 2.5 כ"ס בסלון')));
  assert.ok(quoteToXlsx(specToQuote(third), { prices: false }).size > 0);
});

test("the reply has a section per quote, the unplaced list and the add-ons, and parses back for the SKN request", () => {
  const reply = formatQuotesReply(result);
  assert.ok(reply.includes("📄 *שמעון התרסי 20 תל אביב רכוש משותף*"));
  assert.ok(reply.includes("📄 *שמעון התרסי 20 תל אביב דירה 12 צד ג'*"));
  assert.ok(reply.includes("*שיקום מבנה לאחר נזק אש*"));
  assert.ok(reply.includes("• נקיון ארונות מתכת: 6 יח'"));
  assert.ok(!reply.includes("לא שובץ"));
  assert.ok(reply.includes("*סעיפים שבדרך כלל מתווספים:*"));
  assert.deepEqual(result.addons, [ADDON_SOOT_SUCTION, ADDON_GENERAL_CLEAN]);

  const parsed = parseQuotesReply(`${reply}\n\nלקובץ לבינארית כתבו: שלח SKN`);
  assert.equal(parsed.length, 2);
  for (const [index, spec] of result.quotes.entries()) {
    assert.equal(parsed[index].title, spec.title);
    assert.equal(parsed[index].chapterTitle, spec.chapterTitle);
    assert.equal(parsed[index].subTitle, spec.subTitle);
    assert.deepEqual(parsed[index].items.map(i => [i.unit, i.quantity ?? 0, i.description]), spec.items.map(i => [i.unit, i.quantity ?? 0, i.description]));
  }
  const last = findLastQuotes([{ role: "user", content: "x" }, { role: "assistant", content: reply }]);
  assert.equal(last.quotes.length, 2);
});

test("add-ons: none when the general cleaning is already there and there is no fire", () => {
  const plain = buildQuotes({
    quotes: [{ address: "", party_kind: "other", party_label: "", items: [item("other", { description: "נקיון כללי בסיום העבודות", unit: "09", quantity_parts: [1], quantity_source: "1" }), item("other", { description: "תיקון נזילה" })] }],
    unplaced: [],
  }, "נקיון כללי בסיום העבודות 1 תיקון נזילה");
  assert.deepEqual(plain.addons, []);
  assert.equal(plain.quotes[0].chapterTitle, CHAPTER.water);
});

test("extractQuotes sends a strict structured request and builds the quotes from the answer", async () => {
  let body;
  const fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(MODEL_ANSWER) } }] }) };
  };
  const built = await extractQuotes(TEXT, { apiKey: "k", fetch });
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(built.quotes.length, 2);
  await assert.rejects(extractQuotes(TEXT, { apiKey: "k", fetch: async () => ({ ok: false, status: 500 }) }));
});

test("the unplaced list is shown with the original words and is not read back as items", () => {
  const withLeftover = buildQuotes({
    quotes: [{ address: "", party_kind: "other", party_label: "", items: [item("other", { text: "צבע קירות 3 מטר", description: "צבע קירות", unit: "03", leftover: "מילה שנשארה" })] }],
    unplaced: ["חלק שלא הובן"],
  }, "צבע קירות 3 מטר");
  const reply = formatQuotesReply(withLeftover);
  assert.ok(reply.includes("*לא שובץ:*") && reply.includes("• חלק שלא הובן") && reply.includes("מילה שנשארה"));
  assert.equal(parseQuotesReply(reply)[0].items.length, 1);
});

test("singular element with no quantity is one; plural or unclear stays missing", () => {
  const built = buildQuotes({
    quotes: [{ address: "", party_kind: "other", party_label: "", items: [
      item("replace", { text: "כיור", subject: "כיור במטבח", singular_noun: true }),
      item("replace", { text: "דלתות", subject: "דלתות פנים", singular_noun: false }),
      item("replace", { text: "דלת", subject: "דלת כניסה", singular_noun: false }),
      item("replace", { text: "סורגים", subject: "סורג", singular_noun: true }), // not a known countable noun: unclear
      item("replace", { text: "דלת 3", subject: "דלת פנים", singular_noun: true, quantity_parts: [3], quantity_source: "3" }),
    ] }],
    unplaced: [],
  }, "כיור דלתות דלת סורגים דלת 3");
  assert.deepEqual(built.quotes[0].items.map(i => i.quantity), [1, 1, null, null, null, null, null, null, 3, 3]);
});

test("a bare replaceable element becomes a replacement; named actions do not", () => {
  const built = buildQuotes({
    quotes: [{ address: "", party_kind: "other", party_label: "", items: [
      item("other", { text: "ארון", description: "ארון", singular_noun: true }),
      item("other", { text: "נקיון ארון", description: "נקיון ארון" }),
      item("other", { text: "צביעת דלת", description: "צביעת דלת" }),
      item("other", { text: "תיקון חלון", description: "תיקון חלון" }),
    ] }],
    unplaced: [],
  }, "ארון נקיון ארון צביעת דלת תיקון חלון");
  assert.deepEqual(built.quotes[0].items.map(i => i.description), ["פרוק ופינוי ארון", 'או"ה ארון כדוגמת הקיים', "נקיון ארון", "צביעת דלת", "תיקון חלון"]);
  assert.deepEqual(built.quotes[0].items.slice(0, 2).map(i => i.quantity), [1, 1]);
});

test("a colour that is not in the text is ignored; painting without a colour keeps the existing-shade wording", () => {
  const raw = color => ({ quotes: [{ address: "", party_kind: "other", party_label: "", items: [item("soot_clean", { text: "פיח" }), item("paint_after_soot", { text: "צביעה", color })] }], unplaced: [] });
  assert.equal(buildQuotes(raw("גוון כחול"), "פיח וצביעה בכחול").quotes[0].items[1].description, 'צביעת הנ"ל במספר שכבות בגוון כחול עד לקבלת גוון אחיד ומושלם');
  assert.equal(buildQuotes(raw("ירוק"), "פיח וצביעה").quotes[0].items[1].description, HOUSE.paint);
  assert.equal(buildQuotes(raw(""), "פיח וצביעה").quotes[0].items[1].description, HOUSE.paint);
});
