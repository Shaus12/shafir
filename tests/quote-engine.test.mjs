import { test } from "node:test";
import assert from "node:assert/strict";
import { decode1255 } from "../src/skn/codec.mjs";
import {
  buildQuotes, extractQuotes, formatQuotesReply, specToQuote, numbersIn, resolveQuantity, normalizeDimensions, quoteOutput, locationWithB,
  HOUSE, CHAPTER, ADDON_SOOT_SUCTION, ADDON_GENERAL_CLEAN, SCRAMBLED_REPLY,
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
        item("soot_clean", { text: "נקיון ונטרול פיח קומת כניסה, גרם מדרגות 4 קומות", location: "קומת כניסה, גרם מדרגות 4 קומות", quantity_parts: [4], quantity_source: "4 קומות" }),
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
        item("replace", { text: 'מבואת דירות החלפת פרקט 8 מ"ר', subject: "פרקט", location: "מבואת דירות", unit: "03", quantity_parts: [8], quantity_source: '8 מ"ר' }),
        // one phrase with two different actions on the same area: the engine makes two items, both with the area
        item("other", { text: "נטרול פיח וצביעת מבואת דירות" }),
      ],
    },
  ],
  unplaced: [],
  unreadable: false,
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
  assert.deepEqual([common.items[0].unit, common.items[0].quantity], ["01", null]); // "4 קומות" only describes the place: no quantity
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
  assert.ok(invented.unplaced.some(entry => entry.endsWith("(כמות לא אומתה)")));
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
    quotes: [{ address: "", party_kind: "other", party_label: "", items: [item("other", { text: "נקיון כללי בסיום העבודות 1", description: "נקיון כללי בסיום העבודות", unit: "09", quantity_parts: [1], quantity_source: "1" }), item("other", { text: "תיקון נזילה", description: "תיקון נזילה" })] }],
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
  const text = "צבע קירות 3 מטר צביעת תקרה 4 מטר צביעת פינה 2 מטר גוון חם לא הובן";
  const withLeftover = buildQuotes({
    quotes: [{ address: "", party_kind: "other", party_label: "", items: [
      item("other", { text: "צבע קירות 3 מטר", description: "צבע קירות", unit: "03" }),
      item("other", { text: "צביעת תקרה 4 מטר", description: "צביעת תקרה", unit: "03" }),
      item("other", { text: "צביעת פינה 2 מטר", description: "צביעת פינה", unit: "03", leftover: "גוון חם" }),
    ] }],
    unplaced: ["לא הובן"],
    unreadable: false,
  }, text);
  const reply = formatQuotesReply(withLeftover);
  assert.ok(reply.includes("*לא שובץ:*") && reply.includes("• לא הובן") && reply.includes("גוון חם"));
  assert.equal(parseQuotesReply(reply)[0].items.length, 3);
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

// ---------- hardening ----------

const NOW = new Date("2026-10-24T09:00:00Z");
const single = (items, extra = {}) => ({ quotes: [{ address: "", party_kind: "other", party_label: "", items, ...extra }], unplaced: [], unreadable: false });

test("scrambled text (the example with its words reversed): no items, no files, only the scrambled reply", () => {
  const scrambled = TEXT.split(/\s+/).reverse().join(" ");
  // Even a model that keeps returning the items it "sees" cannot get output through: its phrases are not in the text.
  const built = buildQuotes(MODEL_ANSWER, scrambled);
  assert.equal(built.unreadable, true);
  assert.deepEqual([built.quotes, built.unplaced, built.addons], [[], [], []]);
  const out = quoteOutput(built, { skn: true });
  assert.equal(out.reply, SCRAMBLED_REPLY);
  assert.equal(out.reply, "הטקסט נראה משובש (אולי הועתק מקובץ PDF). שלחו אותו שוב בהקלדה או בהקלטה.");
  assert.deepEqual(out.specs, []); // the webhook sends files only for these specs

  // The model flagging the text as unreadable is enough, whatever else it returned.
  const flagged = buildQuotes({ ...MODEL_ANSWER, unreadable: true }, TEXT);
  assert.equal(flagged.unreadable, true);
  assert.deepEqual(quoteOutput(flagged).specs, []);

  // The real example is not flagged.
  assert.equal(buildQuotes(MODEL_ANSWER, TEXT).unreadable, false);
  assert.ok(quoteOutput(buildQuotes(MODEL_ANSWER, TEXT)).specs.length === 2);
});

test("more than a third of the text not placed in any item is unreadable", () => {
  const text = "צבע קירות 3 מטר ועוד הרבה מילים שאף אחד לא שיבץ לשום סעיף בכלל";
  const built = buildQuotes(single([item("other", { text: "צבע קירות 3 מטר", description: "צבע קירות", unit: "03", quantity_parts: [3], quantity_source: "3 מטר" })]), text);
  assert.equal(built.unreadable, true);
  assert.equal(buildQuotes({ quotes: [], unplaced: [], unreadable: false }, "מה שלומך היום אצלך בבית אצל כולם").unreadable, false); // nothing extracted: help message, not "scrambled"
});

test("multiplication only for an explicit pattern in the same phrase", () => {
  assert.equal(resolveQuantity([2, 3], "2 יחידות בקומה 3 קומות", "2 יחידות בקומה 3 קומות").quantity, 6);
  assert.equal(resolveQuantity([2, 3], "שתי יחידות בקומה שלוש קומות", "שתי יחידות בקומה שלוש קומות").quantity, 6);
  assert.equal(resolveQuantity([4, 5], "4 כפול 5", "4 כפול 5").quantity, 20);
  assert.equal(resolveQuantity([3, 2], "3 פי 2", "3 פי 2").quantity, 6);
  assert.equal(resolveQuantity([2, 3], "2 בחדר 3 חדרים", "2 בחדר 3 חדרים").quantity, 6);
  // any other pair of numbers is never multiplied
  const text = 'ניקיון 45 מ"ר צביעה 8 מ"ר';
  assert.equal(resolveQuantity([45, 8], '45 מ"ר צביעה 8 מ"ר', text).quantity, null);
  assert.equal(resolveQuantity([5, 12], "5 יחידות 12 קומות", "5 יחידות 12 קומות").quantity, null);
  assert.equal(resolveQuantity([2, 3, 4], "2 כפול 3 כפול 4", "2 כפול 3 כפול 4").quantity, null);
  assert.equal(resolveQuantity([6], "2 כפול 3", "2 כפול 3").quantity, null); // a part that is not read from the words
  const built = buildQuotes(single([item("other", { text: 'ארונות מתכת 45 מ"ר 8 מ"ר', description: "ארונות מתכת", quantity_parts: [45, 8], quantity_source: '45 מ"ר 8 מ"ר' })]), 'ארונות מתכת 45 מ"ר 8 מ"ר');
  assert.equal(built.quotes[0].items.at(-1).quantity, null);
});

test("replacements only for elements in the fixed list, whatever the model says", () => {
  const text = "החלפת קירות ותקרת המבנה 50 מטר החלפת קיר גבס 3 החלפת דלת פנים";
  const built = buildQuotes(single([
    item("replace", { text: "החלפת קירות ותקרת המבנה 50 מטר", subject: "קירות ותקרת המבנה", description: "קירות ותקרת המבנה", unit: "03", quantity_parts: [50], quantity_source: "50 מטר" }),
    item("replace", { text: "החלפת קיר גבס 3", subject: "קיר גבס", description: "קיר גבס" }),
    item("replace", { text: "החלפת דלת פנים", subject: "דלת פנים", singular_noun: true }),
  ]), text);
  assert.deepEqual(built.quotes[0].items.map(i => i.description), [
    "קירות ותקרת המבנה", "קיר גבס", "פרוק ופינוי דלת פנים", 'או"ה דלת פנים כדוגמת הקיים',
  ]);
  // a surface named by a "bare" item is not turned into a replacement either
  const surfaces = buildQuotes(single([
    item("other", { text: "קירות", description: "קירות" }), item("other", { text: "תקרה", description: "תקרה" }), item("other", { text: "רצפה", description: "רצפה" }),
  ]), "קירות תקרה רצפה");
  assert.deepEqual(surfaces.quotes[0].items.map(i => i.description), ["קירות", "תקרה", "רצפה"]);
  // the air conditioner kind needs an air conditioner in the text
  const notAc = buildQuotes(single([item("ac_replace", { text: "החלפת רדיאטור בסלון", description: "רדיאטור בסלון" })]), "החלפת רדיאטור בסלון");
  assert.deepEqual(notAc.quotes[0].items.map(i => i.description), ["רדיאטור בסלון"]);
});

test("a quantity above 30 units or 1000 m / m² is kept but marked for checking", () => {
  const text = "כלים 60 ספסלים 30 ריצוף 1500 שטיחים 1000 עבודה 31";
  const built = buildQuotes(single([
    item("other", { text: "כלים 60", description: "כלים", quantity_parts: [60], quantity_source: "60" }),
    item("other", { text: "ספסלים 30", description: "ספסלים", quantity_parts: [30], quantity_source: "30" }),
    item("other", { text: "ריצוף 1500", description: "ריצוף", unit: "03", quantity_parts: [1500], quantity_source: "1500" }),
    item("other", { text: "שטיחים 1000", description: "שטיחים", unit: "03", quantity_parts: [1000], quantity_source: "1000" }),
    item("other", { text: "עבודה 31", description: "עבודה", unit: "09", quantity_parts: [31], quantity_source: "31" }),
  ]), text);
  const reply = formatQuotesReply(built);
  assert.ok(reply.includes("• כלים: 60 יח' (לבדיקה)"));
  assert.ok(reply.includes("• ספסלים: 30 יח'") && !reply.includes("• ספסלים: 30 יח' (לבדיקה)"));
  assert.ok(reply.includes('• ריצוף: 1500 מ"ר (לבדיקה)'));
  assert.ok(reply.includes('• שטיחים: 1000 מ"ר') && !reply.includes('• שטיחים: 1000 מ"ר (לבדיקה)'));
  assert.ok(reply.includes("• עבודה: 31 קומפ' (לבדיקה)"));
  assert.equal(built.quotes[0].items[0].quantity, 60); // kept, not changed
  assert.equal(parseQuotesReply(reply)[0].items[0].quantity, 60); // the marker does not break reading the reply back
});

test("the unplaced list holds only whole phrases found in the text", () => {
  const text = "צביעת קיר צביעת תקרה צביעת רצפה לא הובן";
  const built = buildQuotes({
    quotes: [{ address: "", party_kind: "other", party_label: "", items: ["צביעת קיר", "צביעת תקרה", "צביעת רצפה"].map(t => item("other", { text: t, description: t })) }],
    unplaced: ["לא הובן", "מילה", "ביטוי שלא קיים בטקסט"],
    unreadable: false,
  }, text);
  assert.deepEqual(built.unplaced, ["לא הובן"]); // a single word and a phrase that is not in the text never get in
});

test("the unplaced list shows at most 10 lines, then ועוד N", () => {
  const entries = Array.from({ length: 15 }, (_, k) => `ביטוי מספר ${k + 1}`);
  const reply = formatQuotesReply({ quotes: [{ title: "", chapterTitle: CHAPTER.other, subTitle: HOUSE.commonSub, items: [{ unit: "01", quantity: 1, description: "צביעת קיר" }] }], unplaced: entries, addons: [] });
  const lines = reply.split("\n");
  const start = lines.indexOf("*לא שובץ:*");
  assert.equal(lines.slice(start + 1).filter(line => line.startsWith("•")).length, 10);
  assert.ok(lines.includes("ועוד 5"));
});

test("titles come from phrases found in the text, at most 60 characters; no address means הצעה <date>", () => {
  const noAddress = buildQuotes(single([item("other", { text: "צביעת קיר", description: "צביעת קיר" })], { address: "רחוב שלא קיים 5 עיר" }), "צביעת קיר", { now: NOW });
  assert.equal(noAddress.quotes[0].title, "הצעה 24/10/2026");

  const address = "רחוב הארבעה עשר מאוד ארוך מספר מאה ועשרים וחמש בעיר בלי סוף ובלי גבול";
  const text = `${address} רכוש משותף צביעת קיר`;
  const long = buildQuotes(single([item("other", { text: "צביעת קיר", description: "צביעת קיר" })], { address, party_kind: "common_property", party_label: "רכוש משותף" }), text, { now: NOW });
  assert.ok(long.quotes[0].title.length <= 60);
  assert.ok(text.includes(long.quotes[0].title.split(" ").slice(0, 3).join(" ")));

  // a party that is not in the text is not invented into the title
  const noParty = buildQuotes(single([item("other", { text: "צביעת קיר", description: "צביעת קיר" })], { address: "הרצל 5 חיפה", party_kind: "third_party", party_label: "דירה 9 צד ג'" }), "הרצל 5 חיפה צביעת קיר");
  assert.equal(noParty.quotes[0].title, "הרצל 5 חיפה");
});

test("two quotes with the same title are merged", () => {
  const text = "הרצל 5 חיפה צביעת קיר הרצל 5 חיפה צביעת תקרה";
  const built = buildQuotes({
    quotes: [
      { address: "הרצל 5 חיפה", party_kind: "other", party_label: "", items: [item("other", { text: "צביעת קיר", description: "צביעת קיר" })] },
      { address: "הרצל 5 חיפה", party_kind: "other", party_label: "", items: [item("other", { text: "צביעת תקרה", description: "צביעת תקרה" })] },
    ],
    unplaced: [],
    unreadable: false,
  }, text);
  assert.equal(built.quotes.length, 1);
  assert.deepEqual(built.quotes[0].items.map(i => i.description), ["צביעת קיר", "צביעת תקרה"]);
});

// ---------- house wording only where it belongs ----------

const rows = quote => quote.items.map(i => [i.description, i.unit, i.quantity]);

test("the expected items of the example, quote by quote", () => {
  assert.deepEqual(rows(common), [
    [`${HOUSE.soot} בקומת כניסה ובגרם מדרגות 4 קומות`, "01", null],
    ['צביעת הנ"ל במספר שכבות בגוון לבן עד לקבלת גוון אחיד ומושלם', "01", 5],
    ["נקיון חיפוי שיש", "01", 5],
    ["נקיון ארונות מתכת", "01", 6],
    ["נקיון וצביעת דלת מעלית", "01", 2],
    ["קרצוף רצפה כולל מבואת כניסה", "01", 5],
  ]);
  assert.deepEqual(rows(third), [
    ["פרוק ופינוי חלון אלומיניום זכוכית בלבד במידות 242/217", "01", 1],
    ['או"ה חלון אלומיניום זכוכית בלבד במידות 242/217 כדוגמת הקיים', "01", 1],
    [HOUSE.soot, "03", 50],
    [HOUSE.paint, "03", 50],
    ["צביעת דלתות", "01", 3],
    ["נקיון צמודי מבנה", "09", 1],
    ["פרוק ופינוי מזגן בסלון", "01", 1],
    ['או"ה מזגן מפוצל 2.5 כ"ס בסלון כדוגמת הקיים', "01", 1],
    ["פרוק ופינוי מזגן בחדר שינה", "01", 1],
    ['או"ה מזגן מפוצל 1.25 כ"ס בחדר שינה כדוגמת הקיים', "01", 1],
    ["פרוק ופינוי פרקט ברצפת המבנה", "03", 45],
    ['או"ה פרקט ברצפת המבנה כדוגמת הקיים', "03", 45],
    ["פרוק ופינוי פרקט במבואת דירות", "03", 8],
    ['או"ה פרקט במבואת דירות כדוגמת הקיים', "03", 8],
    [`${HOUSE.soot} במבואת דירות`, "03", null],
    [`${HOUSE.paint} במבואת דירות`, "03", null],
  ]);
  assert.deepEqual(result.unplaced, []);
});

test("soot and painting wording only for walls, ceilings or an area; a specific element keeps its words", () => {
  const text = "נקיון חיפוי שיש 5 יחידות נקיון פיח דלת מעלית נטרול פיח מקירות ותקרה צבע דלתות שלוש יחידות צביעת קירות";
  const built = buildQuotes(single([
    // the model labels all of them with the house kinds; the code decides from the words
    item("soot_clean", { text: "נקיון חיפוי שיש 5 יחידות", description: "נקיון חיפוי שיש", quantity_parts: [5], quantity_source: "5 יחידות" }),
    item("soot_clean", { text: "נקיון פיח דלת מעלית", description: "נקיון פיח דלת מעלית" }),
    item("soot_clean", { text: "נטרול פיח מקירות ותקרה" }),
    item("paint_after_soot", { text: "צבע דלתות שלוש יחידות", description: "צבע דלתות", quantity_parts: [3], quantity_source: "שלוש יחידות" }),
    item("paint_after_soot", { text: "צביעת קירות", description: "צביעת קירות" }),
  ]), text);
  assert.deepEqual(rows(built.quotes[0]), [
    ["נקיון חיפוי שיש", "01", 5],
    ["נקיון פיח דלת מעלית", "01", null],
    [HOUSE.soot, "03", null],
    ["צביעת דלתות", "01", 3],
    ["צביעת קירות", "03", null], // not right after its soot cleaning (the element painting came between)
  ]);
});

test("painting wording needs the soot cleaning right before it", () => {
  const text = "נטרול פיח מקירות ותקרה נקיון חיפוי שיש צביעת קירות ותקרה";
  const built = buildQuotes(single([
    item("soot_clean", { text: "נטרול פיח מקירות ותקרה" }),
    item("other", { text: "נקיון חיפוי שיש", description: "נקיון חיפוי שיש" }),
    item("paint_after_soot", { text: "צביעת קירות ותקרה", description: "צביעת קירות ותקרה" }),
  ]), text);
  assert.equal(built.quotes[0].items[2].description, "צביעת קירות ותקרה");
});

test("a location is joined with ב", () => {
  assert.equal(locationWithB("קומת כניסה, גרם מדרגות 4 קומות"), "בקומת כניסה ובגרם מדרגות 4 קומות");
  assert.equal(locationWithB("קומת כניסה וגרם מדרגות"), "בקומת כניסה ובגרם מדרגות");
  assert.equal(locationWithB("מבואת דירות"), "במבואת דירות");
  assert.equal(locationWithB("בקומה 3"), "בקומה 3");
});

test("two actions on one area are two items with the area, once; one element's cleaning and painting is one item", () => {
  const text = "נטרול פיח וצביעת מבואת דירות נקיון וצביעת דלת מעלית 2 יחידות";
  const phrase = "נטרול פיח וצביעת מבואת דירות";
  // whether the model returns the phrase once or already split in two, the result is the same pair
  for (const items of [
    [item("other", { text: phrase })],
    [item("soot_clean", { text: phrase }), item("paint_after_soot", { text: phrase })],
  ]) {
    const built = buildQuotes(single([...items, item("other", { text: "נקיון וצביעת דלת מעלית 2 יחידות", description: "נקיון וצביעת דלת מעלית", quantity_parts: [2], quantity_source: "2 יחידות" })]), text);
    assert.deepEqual(rows(built.quotes[0]), [
      [`${HOUSE.soot} במבואת דירות`, "03", null],
      [`${HOUSE.paint} במבואת דירות`, "03", null],
      ["נקיון וצביעת דלת מעלית", "01", 2],
    ]);
  }
});

test("replacements keep the location", () => {
  const built = buildQuotes(single([item("replace", { text: 'מבואת דירות החלפת פרקט 8 מ"ר', subject: "פרקט", location: "מבואת דירות", unit: "03", quantity_parts: [8], quantity_source: '8 מ"ר' })]), 'מבואת דירות החלפת פרקט 8 מ"ר');
  assert.deepEqual(rows(built.quotes[0]), [["פרוק ופינוי פרקט במבואת דירות", "03", 8], ['או"ה פרקט במבואת דירות כדוגמת הקיים', "03", 8]]);
});

test("multiplication: <n> <unit> בקומה <m> <יחידות|קומות>", () => {
  assert.equal(resolveQuantity([2, 3], "2 יחידות בקומה 3 יחידות", "2 יחידות בקומה 3 יחידות").quantity, 6);
  assert.equal(resolveQuantity([2, 3], "2 יחידות בקומה 3 קומות", "2 יחידות בקומה 3 קומות").quantity, 6);
  assert.equal(resolveQuantity([2, 3], "2 ארונות בקומה 3 קומות", "2 ארונות בקומה 3 קומות").quantity, 6);
  assert.equal(resolveQuantity([2, 3], "2 יחידות 3 קומות", "2 יחידות 3 קומות").quantity, null);
});

test("a number that only describes the place is not the quantity", () => {
  const text = "נטרול פיח גרם מדרגות 4 קומות נטרול פיח גרם מדרגות 4 קומות 5 יחידות";
  const built = buildQuotes(single([
    item("soot_clean", { text: "נטרול פיח גרם מדרגות 4 קומות", location: "גרם מדרגות 4 קומות", quantity_parts: [4], quantity_source: "4 קומות", unit: "03" }),
    item("soot_clean", { text: "נטרול פיח גרם מדרגות 4 קומות 5 יחידות", location: "גרם מדרגות 4 קומות", quantity_parts: [5], quantity_source: "5 יחידות" }),
  ]), text);
  assert.deepEqual(built.quotes[0].items.map(i => [i.unit, i.quantity]), [["01", null], ["01", 5]]);
});

test("a verb that is part of an item's own action is never listed as not placed", () => {
  const text = "נקיון חיפוי שיש 5 יחידות החלפת מזגן בסלון";
  const built = buildQuotes({ quotes: [{ address: "", party_kind: "other", party_label: "", items: [
    item("other", { text: "נקיון חיפוי שיש 5 יחידות", description: "נקיון חיפוי שיש", quantity_parts: [5], quantity_source: "5 יחידות", leftover: "נקיון" }),
    item("ac_replace", { text: "החלפת מזגן בסלון", room: "בסלון", leftover: "החלפת" }),
  ] }], unplaced: ["החלפת מזגן", "נקיון חיפוי", "מזגן בסלון"], unreadable: false }, text);
  assert.deepEqual(built.unplaced, []);
});

test("a missing quantity is an empty cell in Excel; the SKN writer writes 0.00 and keeps the item", async () => {
  const quote = specToQuote({ title: "בדיקה", chapterTitle: CHAPTER.other, subTitle: HOUSE.commonSub, items: [
    { unit: "01", quantity: null, description: "בלי כמות" },
    { unit: "01", quantity: 5, description: "עם כמות" },
  ] });
  const xml = await quoteToXlsx(quote, { prices: false }).text();
  assert.equal((xml.match(/<c r="D\d+"/g) || []).length, 2); // the header "כמות" and the one item with a quantity
  assert.ok(!xml.includes("<v>0</v>"));

  const skn = quoteToSkn(quote);
  assert.ok(decode1255(skn).includes("010101010" + "01" + "000000.00")); // no way to leave it empty in the fixed-width format
  const back = sknToQuote(skn).chapters[0].subchapters[0].items;
  assert.deepEqual(back.map(i => [i.unit, i.qty]), [["01", 0], ["01", 5]]);
});

// ---------- party split, multiplication from the sentence, verbs, units ----------

const run = (items, text, extra = {}) => buildQuotes(single(items, extra), text);

test("only a party opens a quote: places stay in the current quote with the place in the description", () => {
  assert.equal(result.quotes.length, 2);
  assert.deepEqual(result.quotes.map(q => q.subTitle), ["עבודות מבנה", "דירה 12 צד ג'"]);
  assert.equal(third.items.filter(i => i.description.includes("מבואת דירות")).length, 4); // the מבואת דירות items are in the third-party quote
  assert.equal(common.items.find(i => i.description.startsWith("נקיון ארונות מתכת")).quantity, 6);
  assert.deepEqual(result.unplaced, []);
  assert.ok(!formatQuotesReply(result).includes("לא שובץ"));

  // the model opening a quote for "מבואת דירות" does not make it one: its items move into the third-party quote
  const split = structuredClone(MODEL_ANSWER);
  const moved = split.quotes[1].items.splice(-2); // the parquet replacement and the soot + painting phrase
  split.quotes.push({ address: "", party_kind: "apartment", party_label: "מבואת דירות", items: moved });
  const built = buildQuotes(split, TEXT);
  assert.equal(built.quotes.length, 2);
  assert.deepEqual(rows(built.quotes[1]), rows(third));

  // a place that is not in an item's words is added to the description
  const text = "דירה 5 צד ג' צביעת תקרה חדר שינה צביעת קיר";
  const places = buildQuotes({ quotes: [
    { address: "", party_kind: "third_party", party_label: "דירה 5 צד ג'", items: [item("other", { text: "צביעת תקרה", description: "צביעת תקרה" })] },
    { address: "", party_kind: "other", party_label: "חדר שינה", items: [item("other", { text: "צביעת קיר", description: "צביעת קיר" })] },
    { address: "", party_kind: "apartment", party_label: "סלון", items: [] },
  ], unplaced: [], unreadable: false }, text);
  assert.equal(places.quotes.length, 1);
  assert.deepEqual(places.quotes[0].items.map(i => i.description), ["צביעת תקרה", "צביעת קיר בחדר שינה"]);
});

test("the multiplication pattern is found in the original sentence when the model passed only the first number", () => {
  const text = "נקיון ארונות מתכת 2 יחידות בקומה 3 יחידות";
  const cabinets = quantity => run([item("other", { text, description: "נקיון ארונות מתכת", ...quantity })], text).quotes[0].items[0];
  assert.equal(cabinets({ quantity_parts: [2], quantity_source: "2 יחידות" }).quantity, 6);
  assert.equal(cabinets({ quantity_parts: [2, 3], quantity_source: "2 יחידות בקומה 3 יחידות" }).quantity, 6);
  assert.equal(cabinets({ quantity_parts: [3], quantity_source: "3 יחידות" }).quantity, 3); // the n does not match: no multiplication
  assert.equal(cabinets({ quantity_parts: [2], quantity_source: "2 יחידות" }).unit, "01");
  assert.equal(resolveQuantity([2], "2 יחידות", text, "נקיון ארונות מתכת 2 יחידות בקומה 3 יחידות").quantity, 6);
  assert.equal(resolveQuantity([2], "2 יחידות", text, "").quantity, 2);
});

test("replacement verbs of a replacement pair are never listed as not placed", () => {
  const text = "פירוק אספקה והתקנת חלון אלומיניום";
  const built = buildQuotes({
    quotes: [{ address: "", party_kind: "other", party_label: "", items: [item("replace", { text, subject: "חלון אלומיניום", singular_noun: true, leftover: "פירוק אספקה והתקנת" })] }],
    unplaced: ["פירוק אספקה והתקנת", "פירוק אספקה", "אספקה והתקנת חלון"],
    unreadable: false,
  }, text);
  assert.deepEqual(built.unplaced, []);
  assert.equal(built.quotes[0].items.length, 2);
});

test("soot cleaning and painting are never קומפ': a stated unit wins, floors count as יח', otherwise מ\"ר", () => {
  const unitOf = (items, text) => run(items, text).quotes[0].items.map(i => i.unit);
  // no stated unit, the model says קומפ': an area is מ"ר
  assert.deepEqual(unitOf([item("soot_clean", { text: "נטרול פיח מבואה", location: "מבואה", unit: "09" })], "נטרול פיח מבואה"), ["03"]);
  // the location counts floors: יח'
  assert.deepEqual(unitOf([item("soot_clean", { text: "נטרול פיח קומה 3", location: "קומה 3", unit: "09" })], "נטרול פיח קומה 3"), ["01"]);
  // a stated unit wins over the model's unit
  assert.deepEqual(unitOf([item("soot_clean", { text: "נטרול פיח מבואה 20 מטר מרובע", location: "מבואה", unit: "01", quantity_parts: [20], quantity_source: "20 מטר מרובע" })], "נטרול פיח מבואה 20 מטר מרובע"), ["03"]);
  assert.deepEqual(unitOf([
    item("soot_clean", { text: "נטרול פיח מבואה" }),
    item("paint_after_soot", { text: "צביעת הנ\"ל 4 יחידות", unit: "03", quantity_parts: [4], quantity_source: "4 יחידות" }),
  ], "נטרול פיח מבואה צביעת הנ\"ל 4 יחידות"), ["03", "01"]);
  // the painting that follows soot cleaning of floors counts the same way
  assert.deepEqual(unitOf([
    item("soot_clean", { text: "נטרול פיח קומה 2", location: "קומה 2" }),
    item("paint_after_soot", { text: "צביעת הנ\"ל במספר שכבות", unit: "09" }),
  ], "נטרול פיח קומה 2 צביעת הנ\"ל במספר שכבות"), ["01", "01"]);
  // a specific element with the model's קומפ' is not קומפ' either
  assert.deepEqual(unitOf([item("other", { text: "נקיון פיח דלת", description: "נקיון פיח דלת", unit: "09" })], "נקיון פיח דלת"), ["01"]);
  // the example: soot and painting of the third-party quote
  assert.deepEqual([third.items[2].unit, third.items[3].unit, third.items[14].unit, third.items[15].unit], ["03", "03", "03", "03"]);
  assert.equal(common.items[0].unit, "01");
});

// ---------- two verbs, quantity words, ב before ה, nothing used listed ----------

test("an element with two verbs keeps both", () => {
  const text = "נקיון וצביעת דלת מעלית 2 יחידות";
  for (const description of ["צביעת דלת מעלית", "נקיון וצביעת דלת מעלית", ""]) {
    const built = run([item("other", { text, description, quantity_parts: [2], quantity_source: "2 יחידות" })], text);
    assert.deepEqual(rows(built.quotes[0]), [["נקיון וצביעת דלת מעלית", "01", 2]]);
  }
});

test("the quantity words are not part of the description", () => {
  const text = "קרצוף רצפה כולל מבואת כניסה 5 יחידות";
  for (const description of ["קרצוף רצפה כולל מבואת כניסה 5 יחידות", "קרצוף רצפה כולל מבואת כניסה", ""]) {
    const built = run([item("other", { text, description, quantity_parts: [5], quantity_source: "5 יחידות" })], text);
    assert.deepEqual(rows(built.quotes[0]), [["קרצוף רצפה כולל מבואת כניסה", "01", 5]]);
  }
  // the words of a multiplication are removed too
  const cabinets = "נקיון ארונות מתכת 2 יחידות בקומה 3 יחידות";
  assert.deepEqual(rows(run([item("other", { text: cabinets, description: cabinets, quantity_parts: [2], quantity_source: "2 יחידות" })], cabinets).quotes[0]), [["נקיון ארונות מתכת", "01", 6]]);
});

test("ב is never put before ה, and the wordings that already say the building add no location", () => {
  assert.equal(locationWithB("המבנה"), "במבנה");
  assert.equal(locationWithB("קומת כניסה והמבואה"), "בקומת כניסה ובמבואה");
  assert.equal(locationWithB("הכניסה"), "בכניסה");
  for (const location of ["קירות ותקרת המבנה", "המבנה", "בקירות ותקרת המבנה"]) {
    const built = run([item("soot_clean", { text: "נטרול פיח", location }), item("paint_after_soot", { text: "צביעת הנ\"ל" })], "נטרול פיח צביעת הנ\"ל");
    assert.deepEqual(built.quotes[0].items.map(i => i.description), [HOUSE.soot, HOUSE.paint]);
    assert.ok(!formatQuotesReply(built).includes("בהמבנה"));
  }
  // a joint phrase over "קירות ותקרת המבנה": two items, no location added
  const text = "נטרול פיח וצביעת קירות ותקרת המבנה 50 מטר מרובע";
  const pair = run([item("other", { text, unit: "03", quantity_parts: [50], quantity_source: "50 מטר מרובע" })], text);
  assert.deepEqual(rows(pair.quotes[0]), [[HOUSE.soot, "03", 50], [HOUSE.paint, "03", 50]]);
  // a replacement keeps its location, joined correctly
  const door = run([item("replace", { text: "החלפת דלת המבנה", subject: "דלת", location: "המבנה", singular_noun: true })], "החלפת דלת המבנה");
  assert.deepEqual(door.quotes[0].items.map(i => i.description), ["פרוק ופינוי דלת במבנה", 'או"ה דלת במבנה כדוגמת הקיים']);
});

test("words used by a house wording or by the multiplication are not listed as not placed", () => {
  const text = [
    "נטרול פיח קומת כניסה",
    'צביעת הנ"ל במספר שכבות גוון לבן עד לקבלת גוון אחיד ומושלם 5 יחידות',
    "נקיון ארונות מתכת 2 יחידות בקומה 3 יחידות",
  ].join("\n");
  const built = buildQuotes({
    quotes: [{ address: "", party_kind: "other", party_label: "", items: [
      item("soot_clean", { text: "נטרול פיח קומת כניסה", location: "קומת כניסה" }),
      // the model's own words are short: the rest of the sentence is found in the original text
      item("paint_after_soot", { text: 'צביעת הנ"ל', color: "לבן", quantity_parts: [5], quantity_source: "5 יחידות" }),
      item("other", { text: "נקיון ארונות מתכת 2 יחידות", description: "נקיון ארונות מתכת", quantity_parts: [2], quantity_source: "2 יחידות" }),
    ] }],
    unplaced: ["בקומה 3 יחידות", "עד לקבלת גוון אחיד ומושלם", "במספר שכבות גוון לבן"],
    unreadable: false,
  }, text);
  assert.deepEqual(built.unplaced, []);
  assert.equal(built.unreadable, false);
  assert.deepEqual(rows(built.quotes[0]), [
    [`${HOUSE.soot} בקומת כניסה`, "01", null],
    ['צביעת הנ"ל במספר שכבות בגוון לבן עד לקבלת גוון אחיד ומושלם', "01", 5],
    ["נקיון ארונות מתכת", "01", 6],
  ]);
  assert.ok(!formatQuotesReply(built).includes("לא שובץ"));
});

test("the example has an empty לא שובץ and the expected descriptions", () => {
  assert.deepEqual(result.unplaced, []);
  assert.ok(!formatQuotesReply(result).includes("לא שובץ"));
  assert.ok(common.items.some(i => i.description === "נקיון וצביעת דלת מעלית" && i.quantity === 2));
  assert.ok(common.items.some(i => i.description === "קרצוף רצפה כולל מבואת כניסה" && i.quantity === 5));
});
