import { test } from "node:test";
import assert from "node:assert/strict";
import { sealFormToken, openFormToken, FORM_TOKEN_TTL_MS } from "../src/forms/token.mjs";
import { isValidIsraeliId, cleanIsraeliId, cleanFormFields, validateFormFields, israeliIdsInText } from "../src/forms/validate.mjs";
import { extractFormFields } from "../src/forms/extract.mjs";
import { missingRequiredCount, formTemplates, isEmptyFormRequest, parseLabeledLines } from "../src/forms/template.mjs";
import { getFormDefinition, findFormByTrigger, renderFormBody, onlyVisibleValues, formSummary } from "../src/forms/definitions.mjs";
import { formLinkReply } from "../api/agent4u/webhook.mjs";

const secret = "test-forms-secret-that-is-at-least-32-chars";
const waiver = getFormDefinition("waiver");
const fields = { full_name: "משה כהן", id_number: "123456782", damage_description: "נזקי מים במטבח", insurance_company: "הראל" };

test("form token round-trips and hides personal data", () => {
  const token = sealFormToken({ formId: "waiver", fields, clientId: 42, workerPhone: "972521234567" }, { secret, now: 1000 });
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  for (const value of [...Object.values(fields), "972521234567", "waiver"]) {
    assert.equal(token.includes(value), false);
    assert.equal(Buffer.from(token, "base64url").includes(Buffer.from(value)), false);
  }
  const opened = openFormToken(token, { secret, now: 2000 });
  assert.deepEqual(opened, { formId: "waiver", fields, clientId: 42, workerPhone: "972521234567", expiresAt: 1000 + FORM_TOKEN_TTL_MS });
});

test("form token rejects tampering, wrong secret and expiry", () => {
  const token = sealFormToken({ formId: "waiver", fields, clientId: 42, workerPhone: "" }, { secret, now: 1000 });
  const raw = Buffer.from(token, "base64url");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => openFormToken(raw.toString("base64url"), { secret, now: 2000 }), { code: "invalid" });
  assert.throws(() => openFormToken(token, { secret: `${secret}-other`, now: 2000 }), { code: "invalid" });
  assert.throws(() => openFormToken("not a token", { secret, now: 2000 }), { code: "invalid" });
  assert.throws(() => openFormToken(token, { secret, now: 1001 + FORM_TOKEN_TTL_MS }), { code: "expired" });
  assert.throws(() => openFormToken(token, { secret: "short", now: 2000 }), { code: "not_configured" });
});

test("Israeli ID checksum", () => {
  assert.ok(isValidIsraeliId("123456782"));
  assert.ok(isValidIsraeliId("000000018"));
  assert.ok(isValidIsraeliId("18"));
  assert.ok(isValidIsraeliId("123-45678-2"));
  assert.ok(isValidIsraeliId("\u200F123456782"));
  assert.ok(isValidIsraeliId("\u202B123 456 782\u202C\u200E"));
  assert.equal(isValidIsraeliId("123456789"), false);
  assert.equal(isValidIsraeliId("1234567820"), false);
  assert.equal(isValidIsraeliId("000000000"), false);
  assert.equal(isValidIsraeliId(""), false);
});

test("Israeli ID cleaning keeps digits only and pads to 9", () => {
  assert.equal(cleanIsraeliId("18"), "000000018");
  assert.equal(cleanIsraeliId("123-45678-2"), "123456782");
  assert.equal(cleanIsraeliId("\u200F123456782"), "123456782");
  assert.equal(cleanIsraeliId("1234567820"), "1234567820");
  assert.equal(cleanIsraeliId(""), "");
  const cleaned = cleanFormFields(waiver, { ...fields, id_number: "\u200F123-45678-2" });
  assert.equal(cleaned.id_number, "123456782");
  assert.deepEqual(validateFormFields(waiver, cleaned), {});
  assert.deepEqual(validateFormFields(waiver, cleanFormFields(waiver, { ...fields, id_number: "1234567820" })), {
    id_number: "מספר זהות לא תקין",
  });
});

test("fields are cleaned and validated per definition", () => {
  const cleaned = cleanFormFields(waiver, { ...fields, id_number: "123-456 782", extra: "x" });
  assert.equal(cleaned.id_number, "123456782");
  assert.equal("extra" in cleaned, false);
  assert.deepEqual(validateFormFields(waiver, cleaned), {});
  assert.deepEqual(validateFormFields(waiver, { ...cleaned, id_number: "123456789", insurance_company: "" }), {
    id_number: "מספר זהות לא תקין",
    insurance_company: "שדה חובה",
  });
});

test("waiver trigger and legal text are exact", () => {
  assert.equal(findFormByTrigger('כתב ויתור, משה כהן, ת"ז 123456782')?.id, "waiver");
  assert.equal(findFormByTrigger("צביעה 40 מ\"ר"), null);
  const lines = renderFormBody(waiver, fields);
  assert.deepEqual(lines.map(line => line.text), [
    "אני החתום מטה משה כהן",
    "מספר זהות 123456782",
    "מצהיר בזאת כי תיקון נזק נזקי מים במטבח",
    'כפי שאושר ע"י השמאי בוצע לשביעות רצוני ע"י חברת שפיר שיקום נזקים בע"מ ואין לי דרישות נוספות בגין טיב העבודות.',
    "ביצוע התיקון יהווה פיצוי סופי ומוחלט על כל דרישותיי ותביעותיי והנני מתחייב שלא אגיש תביעה מכל סוג שהוא בענין הנזק המפורט לעיל.",
    "עם סיום העבודות הריני לאשר לחברת הביטוח הראל",
    'שהכספים עבור תיקון הנזק המפורט לעיל כפי שאושרו ע"י השמאי, יועברו ישירות לידי חברת שפיר שיקום נזקים בע"מ',
    "שם משה כהן",
    "חתימת הלקוח",
  ]);
  assert.equal(lines.at(-1).signature, true);
});

function fakeModel(fieldsFromModel) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fieldsFromModel) } }] }), { status: 200 });
  };
  return { fetch, calls };
}

const modelFields = { full_name: "משה כהן", id_number: "123456789", damage_description: "נזקי מים במטבח", insurance_company: "הראל" };

test("ID number is read from the message text, never from the model", async () => {
  const messages = [
    "כתב ויתור עבור משה כהן מספר הזהות שלו 123456782 נזקי מים במטבח בהראל",
    'כתב ויתור, משה כהן, ת"ז 123456782, הראל, נזקי מים במטבח',
    'כתב ויתור, משה כהן, ת"ז: 123-45678-2, הראל, נזקי מים במטבח',
    'כתב ויתור, משה כהן, ת"ז \u200F123456782\u200F, הראל, נזקי מים במטבח',
    "כתב ויתור משה כהן 0501234567 123456782 צביעה 40 מ\"ר הראל",
  ];
  for (const message of messages) {
    const { fetch, calls } = fakeModel(modelFields);
    const { fields: result, invalid } = await extractFormFields(waiver, message, { apiKey: "test", fetch });
    assert.equal(result.id_number, "123456782", message);
    assert.deepEqual(invalid, []);
    assert.deepEqual(validateFormFields(waiver, result), {});
    const schema = calls[0].response_format.json_schema.schema;
    assert.equal("id_number" in schema.properties, false);
    assert.equal(schema.required.includes("id_number"), false);
  }
});

test("an invalid ID in the message leaves the field empty and is reported", async () => {
  const { fetch } = fakeModel(modelFields);
  const { fields: result, invalid } = await extractFormFields(waiver, 'כתב ויתור, משה כהן, ת"ז 123456789, הראל, נזקי מים', { apiKey: "test", fetch });
  assert.equal(result.id_number, "");
  assert.deepEqual(invalid, ["id_number"]);
  const reply = formLinkReply(waiver, result, "https://example.com/forms/waiver?t=abc", { invalid });
  assert.ok(reply.includes("מספר הזהות שנשלח לא תקין, הלקוח ישלים אותו בטופס."));
  assert.equal(reply.includes("פרטים שלא זוהו"), false);
});

test("no ID in the message is a missing field, not an invalid one", async () => {
  const { fetch } = fakeModel(modelFields);
  const { fields: result, invalid } = await extractFormFields(waiver, "כתב ויתור, משה כהן, הראל, נזקי מים 40 מ\"ר", { apiKey: "test", fetch });
  assert.equal(result.id_number, "");
  assert.deepEqual(invalid, []);
  assert.deepEqual(israeliIdsInText("צביעה 18 מ\"ר"), { valid: [], invalid: 0 });
});

test("bot reply lists the link and missing fields", () => {
  const reply = formLinkReply(waiver, { ...fields, id_number: "" }, "https://example.com/forms/waiver?t=abc");
  assert.ok(reply.includes("https://example.com/forms/waiver?t=abc"));
  assert.ok(reply.includes("פרטים שלא זוהו והלקוח ישלים בטופס: מספר זהות."));
});

const workOrder = getFormDefinition("work-order");
const privateOrder = {
  work_description: "נזקי מים במטבח", insurance_company: "הראל", customer_type: "private",
  private_name: "משה כהן", private_id: "123456782", private_address: "הרצל 1, אשקלון", private_phone: "0501234567",
  private_fax: "", private_email: "moshe@example.com",
};
const corporateOrder = {
  work_description: "נזקי מים במשרד", insurance_company: "מגדל", customer_type: "corporate",
  company_name: 'אבג בע"מ', company_number: "515555555", guarantor_name: "דנה לוי", guarantor_id: "123456782",
  company_address: "העצמאות 5, באר שבע", company_phone: "086234567", witness_name: "יוסי מזרחי",
};

test("work order trigger and legal text with private customer details", () => {
  assert.equal(findFormByTrigger("הזמנת עבודה, פרטי, משה כהן")?.id, "work-order");
  assert.equal(findFormByTrigger("כתב ויתור, משה כהן")?.id, "waiver");
  const lines = renderFormBody(workOrder, privateOrder);
  assert.deepEqual(lines.map(line => line.text), [
    "הננו מזמינים בזאת ביצוע עבודות שיקום בעקבות נזק נזקי מים במטבח",
    "התשלום יתבצע לפי אישור השמאי וישירות אליכם תוך 30 יום מביצוע העבודה והגשת חשבונכם. למען הסר ספק, ולמרות כל מסמך שנחתם בינינו ולבין חברת הביטוח הראל",
    'הננו ממחים לכם בזאת באופן בלתי חוזר כל סכום שיגיע לנו מחברת הביטוח והננו מורים בזאת לחברת הביטוח לשלם לכם ישירות את תמורת העבודה, וזאת מהכספים המגיעים ו/או שיגיעו לנו, אם יגיעו מחברת הביטוח. מוסכם בזאת, כי לחברת שפיר שיקום נזקים בע"מ תינתן זכות בחירה לגבות הכספים מהחתום מטה או ישירות מחברת הביטוח',
    "פרטי הלקוח",
    "סוג לקוח: לקוח פרטי",
    "שם: משה כהן",
    "תעודת זהות: 123456782",
    "כתובת: הרצל 1, אשקלון",
    "טלפון: 0501234567",
    "כתובת אימייל לשליחת העתק הזמנה: moshe@example.com",
    "חתימת הלקוח",
    "הערות:",
    "1. בכל מחלוקת לגבי טיב העבודה ישמש השמאי מטעם חברת הביטוח, בורר מכריע ויש לראות במסמך זה הסכם בוררות.",
    '2. סמכות שיפוט בלעדית בכל תובענה בנוגע להזמנה, תהיה באשקלון ו/או בבית המשפט המחוזי ב"ש.',
  ]);
  assert.deepEqual(lines.filter(line => line.image).map(line => [line.image, line.signature]), [["private_signature", true]]);
  assert.ok(lines.find(line => line.text === "פרטי הלקוח").heading);
});

test("work order corporate details, stamp image and witness section", () => {
  const lines = renderFormBody(workOrder, corporateOrder);
  const details = lines.slice(lines.findIndex(line => line.text === "פרטי הלקוח"), lines.findIndex(line => line.text === "הערות:"));
  assert.deepEqual(details.map(line => line.text), [
    "פרטי הלקוח",
    "סוג לקוח: לקוח שהוא תאגיד",
    'שם התאגיד: אבג בע"מ',
    "ח.פ: 515555555",
    "תמונת חתימה וחותמת התאגיד",
    "שם הערב האישי לתשלום: דנה לוי",
    "תעודת זהות של הערב האישי לתשלום: 123456782",
    "חתימת הערב האישי לתשלום",
    "כתובת: העצמאות 5, באר שבע",
    "טלפון: 086234567",
    "נחתם בנוכחות",
    "שם מלא: יוסי מזרחי",
    "חתימה",
  ]);
  assert.deepEqual(details.filter(line => line.image).map(line => [line.image, line.signature]), [
    ["company_stamp", false], ["guarantor_signature", true], ["witness_signature", true],
  ]);
});

test("work order validation follows the chosen customer type", () => {
  assert.deepEqual(validateFormFields(workOrder, cleanFormFields(workOrder, privateOrder)), {});
  assert.deepEqual(validateFormFields(workOrder, cleanFormFields(workOrder, corporateOrder)), {});
  assert.deepEqual(validateFormFields(workOrder, cleanFormFields(workOrder, { work_description: "x", insurance_company: "y" })), {
    customer_type: "יש לבחור אפשרות",
  });
  const bad = cleanFormFields(workOrder, { ...privateOrder, private_phone: "12345", private_fax: "abc", private_email: "moshe@", customer_type: "other" });
  assert.equal(bad.customer_type, "");
  assert.equal(bad.private_fax, "");
  const badPrivate = cleanFormFields(workOrder, { ...privateOrder, private_phone: "12345", private_email: "moshe@" });
  assert.deepEqual(validateFormFields(workOrder, badPrivate), { private_phone: "מספר לא תקין", private_email: "כתובת אימייל לא תקינה" });
  const badCorporate = cleanFormFields(workOrder, { ...corporateOrder, company_number: "51-555555", guarantor_id: "123456789" });
  assert.deepEqual(validateFormFields(workOrder, badCorporate), {
    company_number: "ח.פ צריך להכיל 9 ספרות",
    guarantor_id: "מספר זהות לא תקין",
  });
  assert.equal(cleanFormFields(workOrder, { private_phone: "050-123 4567", company_number: "51-555555-5", private_email: " Moshe@Example.com\u200F" }).private_phone, "0501234567");
  assert.equal(cleanFormFields(workOrder, { company_number: "51-555555-5" }).company_number, "515555555");
  assert.equal(cleanFormFields(workOrder, { private_email: " moshe@example.com\u200F" }).private_email, "moshe@example.com");
});

test("hidden fields are emptied before printing, and the caption uses the visible name", () => {
  const mixed = { ...privateOrder, company_name: 'אבג בע"מ' };
  assert.equal(onlyVisibleValues(workOrder, mixed).company_name, "");
  assert.equal(formSummary(workOrder, onlyVisibleValues(workOrder, mixed)), "משה כהן");
  assert.equal(formSummary(workOrder, corporateOrder), 'אבג בע"מ');
  assert.equal(formSummary(waiver, fields), "משה כהן");
});

test("work order ID goes to the single visible ID field, company number excluded", async () => {
  const corporateModel = { ...corporateOrder, guarantor_id: "999999998" };
  for (const message of [
    'הזמנת עבודה, תאגיד, אבג בע"מ, ח.פ 515555555, ערב דנה לוי ת"ז 123456782, מגדל',
    'הזמנת עבודה, תאגיד, אבג בע"מ 515555555, ערב דנה לוי 123-45678-2, מגדל',
  ]) {
    const { fetch, calls } = fakeModel(corporateModel);
    const { fields: result, invalid } = await extractFormFields(workOrder, message, { apiKey: "test", fetch });
    assert.equal(result.guarantor_id, "123456782", message);
    assert.equal(result.private_id, "");
    assert.deepEqual(invalid, []);
    const schema = calls[0].response_format.json_schema.schema;
    assert.deepEqual(schema.properties.customer_type.enum, ["", "private", "corporate"]);
    for (const key of ["private_id", "guarantor_id", "private_signature", "company_stamp", "guarantor_signature", "witness_signature"]) {
      assert.equal(key in schema.properties, false, key);
    }
  }

  const twoIds = fakeModel(privateOrder);
  const both = await extractFormFields(workOrder, 'הזמנת עבודה, פרטי, משה כהן ת"ז 123456782 ואשתו 000000018', { apiKey: "test", fetch: twoIds.fetch });
  assert.equal(both.fields.private_id, "");
  assert.deepEqual(both.invalid, []);

  const noType = fakeModel({ ...privateOrder, customer_type: "" });
  const unknown = await extractFormFields(workOrder, 'הזמנת עבודה, משה כהן ת"ז 123456782', { apiKey: "test", fetch: noType.fetch });
  assert.equal(unknown.fields.private_id, "");
  assert.equal(unknown.fields.guarantor_id, "");
});

test("work order bot reply lists only missing fields of the chosen customer type", () => {
  const reply = formLinkReply(workOrder, cleanFormFields(workOrder, { ...privateOrder, private_email: "" }), "https://example.com/forms/work-order?t=abc");
  assert.ok(reply.startsWith('נוצר טופס "הזמנת עבודה והמחאת זכויות" לחתימה:\nhttps://example.com/forms/work-order?t=abc\n'));
  assert.ok(reply.includes("פרטים שלא זוהו והלקוח ישלים בטופס: כתובת אימייל לשליחת העתק הזמנה."));
  const noType = formLinkReply(workOrder, cleanFormFields(workOrder, { work_description: "x", insurance_company: "y" }), "https://example.com/x");
  assert.ok(noType.includes("פרטים שלא זוהו והלקוח ישלים בטופס: סוג לקוח."));
});

const emptyModelAnswer = def => Object.fromEntries(def.fields
  .filter(field => !["israeli_id", "signature", "image"].includes(field.type))
  .map(field => [field.key, ""]));

test("missing required details are counted without signatures and images", () => {
  assert.equal(missingRequiredCount(waiver, fields), 0);
  assert.equal(missingRequiredCount(waiver, { ...fields, id_number: "" }), 1);
  assert.equal(missingRequiredCount(waiver, { full_name: "משה כהן" }), 3);
  assert.equal(missingRequiredCount(workOrder, privateOrder), 0);
  assert.equal(missingRequiredCount(workOrder, { ...privateOrder, private_fax: "", private_email: "", private_phone: "" }), 2);
  assert.equal(missingRequiredCount(workOrder, corporateOrder), 0);
  assert.equal(missingRequiredCount(workOrder, { work_description: "x", insurance_company: "y" }), 6);
  assert.equal(missingRequiredCount(workOrder, { ...privateOrder, customer_type: "" }), 1);
});

test("fill-in templates are built from the definition", () => {
  assert.deepEqual(formTemplates(waiver, { full_name: "משה כהן" }), [
    "כתב ויתור\nשם מלא: משה כהן\nמספר זהות: \nתיאור הנזק: \nחברת ביטוח: ",
  ]);
  assert.deepEqual(formTemplates(workOrder, { work_description: "נזקי מים", customer_type: "private" }), [
    "הזמנת עבודה\nתיאור העבודה: נזקי מים\nחברת ביטוח: \nסוג לקוח: לקוח פרטי\nשם: \nתעודת זהות: \nכתובת: \nטלפון: \nפקס: \nכתובת אימייל לשליחת העתק הזמנה: ",
  ]);
  assert.deepEqual(formTemplates(workOrder, { insurance_company: "הראל" }), [
    "הזמנת עבודה\nתיאור העבודה: \nחברת ביטוח: הראל\nסוג לקוח: לקוח פרטי\nשם: \nתעודת זהות: \nכתובת: \nטלפון: \nפקס: \nכתובת אימייל לשליחת העתק הזמנה: ",
    "הזמנת עבודה\nתיאור העבודה: \nחברת ביטוח: הראל\nסוג לקוח: לקוח שהוא תאגיד\nשם התאגיד: \nח.פ: \nשם הערב האישי לתשלום: \nתעודת זהות של הערב האישי לתשלום: \nכתובת: \nטלפון: \nשם מלא (נחתם בנוכחות): ",
  ]);
});

test("the trigger followed by ריק asks for an empty link", () => {
  assert.ok(isEmptyFormRequest(workOrder, "הזמנת עבודה ריק"));
  assert.ok(isEmptyFormRequest(workOrder, "  הזמנת עבודה, ריק."));
  assert.ok(isEmptyFormRequest(waiver, "כתב ויתור ריק"));
  assert.ok(isEmptyFormRequest(waiver, "כתב קבלה וויתור ריק"));
  assert.equal(isEmptyFormRequest(waiver, "כתב ויתור ריקי כהן"), false);
  assert.equal(isEmptyFormRequest(waiver, "כתב ויתור משה כהן ריק"), false);
  assert.equal(isEmptyFormRequest(workOrder, "כתב ויתור ריק"), false);
});

test("a filled template is read back in code, including the ID line", async () => {
  const corporateTemplate = [
    "הזמנת עבודה",
    "תיאור העבודה: נזקי מים במשרד",
    "חברת ביטוח: מגדל",
    "סוג לקוח: לקוח שהוא תאגיד",
    'שם התאגיד: אבג בע"מ',
    "ח.פ: 51-555555-5",
    "שם הערב האישי לתשלום: דנה לוי",
    "תעודת זהות של הערב האישי לתשלום: \u200F123-45678-2",
    "כתובת: העצמאות 5, באר שבע",
    "טלפון: 08-6234567",
    "שם מלא (נחתם בנוכחות): יוסי מזרחי",
  ].join("\n");
  const { fetch } = fakeModel(emptyModelAnswer(workOrder));
  const { fields: result, invalid } = await extractFormFields(workOrder, corporateTemplate, { apiKey: "test", fetch });
  assert.deepEqual(invalid, []);
  assert.equal(missingRequiredCount(workOrder, result), 0);
  assert.deepEqual(validateFormFields(workOrder, result), {});
  for (const [key, value] of Object.entries(corporateOrder)) assert.equal(result[key], value, key);

  const privateTemplate = "הזמנת עבודה\nתיאור העבודה: נזקי מים\nחברת ביטוח: הראל\nסוג לקוח: לקוח פרטי\nשם: משה כהן\nתעודת זהות: 123456789\nכתובת: \nטלפון: 050-1234567\nפקס: \nכתובת אימייל לשליחת העתק הזמנה: moshe@example.com";
  const second = fakeModel({ ...emptyModelAnswer(workOrder), private_address: "ניחוש" });
  const parsed = await extractFormFields(workOrder, privateTemplate, { apiKey: "test", fetch: second.fetch });
  assert.equal(parsed.fields.private_id, "");
  assert.deepEqual(parsed.invalid, ["private_id"]);
  assert.equal(parsed.fields.private_address, "");
  assert.equal(parsed.fields.private_phone, "0501234567");

  assert.deepEqual(parseLabeledLines(waiver, "כתב ויתור\nשם מלא: משה כהן\nמספר זהות: 123456782\nתיאור הנזק: \nחברת ביטוח: הראל"), {
    full_name: "משה כהן", id_number: "123456782", damage_description: "", insurance_company: "הראל",
  });
  assert.deepEqual(parseLabeledLines(waiver, 'כתב ויתור, משה כהן, ת"ז: 123456782'), {});
});
