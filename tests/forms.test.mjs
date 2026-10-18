import { test } from "node:test";
import assert from "node:assert/strict";
import { sealFormToken, openFormToken, FORM_TOKEN_TTL_MS } from "../src/forms/token.mjs";
import { isValidIsraeliId, cleanFormFields, validateFormFields } from "../src/forms/validate.mjs";
import { getFormDefinition, findFormByTrigger, renderFormBody } from "../src/forms/definitions.mjs";
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
  assert.equal(isValidIsraeliId("123456789"), false);
  assert.equal(isValidIsraeliId("000000000"), false);
  assert.equal(isValidIsraeliId("12a456782"), false);
  assert.equal(isValidIsraeliId(""), false);
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

test("bot reply lists the link and missing fields", () => {
  const reply = formLinkReply(waiver, { ...fields, id_number: "" }, "https://example.com/forms/waiver?t=abc");
  assert.ok(reply.includes("https://example.com/forms/waiver?t=abc"));
  assert.ok(reply.includes("פרטים שלא זוהו והלקוח ישלים בטופס: מספר זהות."));
});
