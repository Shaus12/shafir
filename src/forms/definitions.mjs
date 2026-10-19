// Signature forms as data. A new form is a new entry here: the bot trigger, the extraction hints,
// the page, the validation and the PDF are all driven by this definition. Usable in the browser and in Node.
//
// FormDefinition = {
//   id:        URL-safe id, used in /forms/<id>
//   title:     form title, shown on the page, in the file name and in the signing record
//   heading:   optional title line printed in the PDF (defaults to title)
//   triggers:  bot messages starting with one of these open this form
//   example:   how to ask for the form, shown in the bot help message
//   preamble:  lines printed above the title in the PDF
//   fields:    [Field]
//   body:      [string | Block], the legal text and the details, in print order
//   summaryField:  field key, or keys (the first visible non-empty one is used), shown in the WhatsApp caption
//   captionPrefix: optional caption start (defaults to "<title> חתום")
// }
//
// Field = {
//   key, label, required, maxLength,
//   type:      "text" | "textarea" | "israeli_id" | "company_number" | "phone" | "email" | "choice" | "image" | "signature"
//                israeli_id:     Israeli ID with check digit; filled from the message text in code, never by the model
//                company_number: 9 digits, no check digit
//                choice:         radio buttons, `options: [{ value, label }]`
//                image:          a photo (JPG/PNG) uploaded on the page, compressed to 600 KB
//                signature:      a finger signature on the page
//   options:   for choice fields
//   when:      optional { choiceKey: value }, the field exists only when that choice has that value
//   section:   page card the field appears in (default "פרטי הלקוח"); signatures get their own cards below the text
//   pageLabel: optional heading for a signature card (defaults to label)
//   templateLabel: optional label in the bot's fill-in template, when the label alone is ambiguous (defaults to label)
//   hint:      tells the extraction model what the field means
// }
//
// Body entries:
//   "text with {key}"           a line; {key} is replaced by the field value (the option label for choices)
//   "label [key]"               a line followed by the image of a signature or image field
//   { heading, when? }          a bold heading line
//   { fields: [keys], when? }   one "label: value" line per visible field, images in place; empty optional fields are left out

export const FORM_DEFINITIONS = Object.freeze([
  {
    id: "waiver",
    title: "כתב קבלה וויתור",
    triggers: ["כתב ויתור", "כתב קבלה וויתור", "כתב קבלה ויתור"],
    preamble: ['בס"ד', 'לכבוד: שפיר שיקום נזקים בע"מ'],
    fields: [
      { key: "full_name", label: "שם מלא", type: "text", required: true, maxLength: 80, hint: "השם המלא של הלקוח שחותם על הטופס" },
      { key: "id_number", label: "מספר זהות", type: "israeli_id", required: true, maxLength: 9 },
      { key: "damage_description", label: "תיאור הנזק", type: "textarea", required: true, maxLength: 400, hint: "תיאור הנזק שתוקן" },
      { key: "insurance_company", label: "חברת ביטוח", type: "text", required: true, maxLength: 60, hint: "שם חברת הביטוח של הלקוח" },
      { key: "signature", label: "חתימת הלקוח", type: "signature", required: true },
    ],
    body: [
      'אני החתום מטה {full_name}',
      'מספר זהות {id_number}',
      'מצהיר בזאת כי תיקון נזק {damage_description}',
      'כפי שאושר ע"י השמאי בוצע לשביעות רצוני ע"י חברת שפיר שיקום נזקים בע"מ ואין לי דרישות נוספות בגין טיב העבודות.',
      'ביצוע התיקון יהווה פיצוי סופי ומוחלט על כל דרישותיי ותביעותיי והנני מתחייב שלא אגיש תביעה מכל סוג שהוא בענין הנזק המפורט לעיל.',
      'עם סיום העבודות הריני לאשר לחברת הביטוח {insurance_company}',
      'שהכספים עבור תיקון הנזק המפורט לעיל כפי שאושרו ע"י השמאי, יועברו ישירות לידי חברת שפיר שיקום נזקים בע"מ',
      'שם {full_name}',
      'חתימת הלקוח [signature]',
    ],
    summaryField: "full_name",
    example: 'כתבו "כתב ויתור" ואחריו שם, ת"ז, תיאור הנזק וחברת הביטוח',
  },
  {
    id: "work-order",
    title: "הזמנת עבודה והמחאת זכויות",
    heading: "הנדון: הזמנת עבודה והמחאת זכויות",
    triggers: ["הזמנת עבודה"],
    preamble: ['בס"ד', 'לכבוד: שפיר שיקום נזקים בע"מ'],
    fields: [
      { key: "work_description", label: "תיאור העבודה", type: "textarea", required: true, maxLength: 500, section: "פרטי ההזמנה", hint: "תיאור הנזק או העבודות שהלקוח מזמין" },
      { key: "insurance_company", label: "חברת ביטוח", type: "text", required: true, maxLength: 60, section: "פרטי ההזמנה", hint: "שם חברת הביטוח של הלקוח" },
      {
        key: "customer_type", label: "סוג לקוח", type: "choice", required: true, section: "פרטי ההזמנה",
        options: [{ value: "private", label: "לקוח פרטי" }, { value: "corporate", label: "לקוח שהוא תאגיד" }],
        hint: "private אם נכתב שהלקוח פרטי, corporate אם נכתב שהלקוח תאגיד או חברה",
      },

      { key: "private_name", label: "שם", type: "text", required: true, maxLength: 80, when: { customer_type: "private" }, hint: "שם הלקוח, כשהלקוח פרטי" },
      { key: "private_id", label: "תעודת זהות", type: "israeli_id", required: true, maxLength: 9, when: { customer_type: "private" } },
      { key: "private_address", label: "כתובת", type: "text", required: true, maxLength: 150, when: { customer_type: "private" }, hint: "כתובת הלקוח, כשהלקוח פרטי" },
      { key: "private_phone", label: "טלפון", type: "phone", required: true, maxLength: 20, when: { customer_type: "private" }, hint: "טלפון הלקוח, כשהלקוח פרטי" },
      { key: "private_fax", label: "פקס", type: "phone", required: false, maxLength: 20, when: { customer_type: "private" }, hint: "מספר פקס, רק אם נכתב שזה פקס" },
      { key: "private_email", label: "כתובת אימייל לשליחת העתק הזמנה", type: "email", required: true, maxLength: 120, when: { customer_type: "private" }, hint: "כתובת האימייל של הלקוח, כשהלקוח פרטי" },
      { key: "private_signature", label: "חתימת הלקוח", type: "signature", required: true, when: { customer_type: "private" } },

      { key: "company_name", label: "שם התאגיד", type: "text", required: true, maxLength: 100, when: { customer_type: "corporate" }, hint: "שם התאגיד או החברה" },
      { key: "company_number", label: "ח.פ", type: "company_number", required: true, maxLength: 9, when: { customer_type: "corporate" }, hint: "מספר ח.פ של התאגיד, ספרות בלבד" },
      { key: "company_stamp", label: "תמונת חתימה וחותמת התאגיד", type: "image", required: true, when: { customer_type: "corporate" } },
      { key: "guarantor_name", label: "שם הערב האישי לתשלום", type: "text", required: true, maxLength: 80, when: { customer_type: "corporate" }, hint: "שם הערב האישי לתשלום, רק אם נכתב במפורש שהוא ערב" },
      { key: "guarantor_id", label: "תעודת זהות של הערב האישי לתשלום", type: "israeli_id", required: true, maxLength: 9, when: { customer_type: "corporate" } },
      { key: "guarantor_signature", label: "חתימת הערב האישי לתשלום", type: "signature", required: true, when: { customer_type: "corporate" } },
      { key: "company_address", label: "כתובת", type: "text", required: true, maxLength: 150, when: { customer_type: "corporate" }, hint: "כתובת התאגיד, כשהלקוח תאגיד" },
      { key: "company_phone", label: "טלפון", type: "phone", required: true, maxLength: 20, when: { customer_type: "corporate" }, hint: "טלפון התאגיד, כשהלקוח תאגיד" },
      { key: "witness_name", label: "שם מלא", templateLabel: "שם מלא (נחתם בנוכחות)", type: "text", required: true, maxLength: 80, when: { customer_type: "corporate" }, section: "נחתם בנוכחות", hint: "שם מי שנכח בחתימה, רק אם נכתב במפורש" },
      { key: "witness_signature", label: "חתימה", pageLabel: "חתימה (נחתם בנוכחות)", type: "signature", required: true, when: { customer_type: "corporate" }, section: "נחתם בנוכחות" },
    ],
    body: [
      'הננו מזמינים בזאת ביצוע עבודות שיקום בעקבות נזק {work_description}',
      'התשלום יתבצע לפי אישור השמאי וישירות אליכם תוך 30 יום מביצוע העבודה והגשת חשבונכם. למען הסר ספק, ולמרות כל מסמך שנחתם בינינו ולבין חברת הביטוח {insurance_company}',
      'הננו ממחים לכם בזאת באופן בלתי חוזר כל סכום שיגיע לנו מחברת הביטוח והננו מורים בזאת לחברת הביטוח לשלם לכם ישירות את תמורת העבודה, וזאת מהכספים המגיעים ו/או שיגיעו לנו, אם יגיעו מחברת הביטוח. מוסכם בזאת, כי לחברת שפיר שיקום נזקים בע"מ תינתן זכות בחירה לגבות הכספים מהחתום מטה או ישירות מחברת הביטוח',
      { heading: "פרטי הלקוח" },
      { fields: ["customer_type"] },
      { fields: ["private_name", "private_id", "private_address", "private_phone", "private_fax", "private_email", "private_signature"] },
      { fields: ["company_name", "company_number", "company_stamp", "guarantor_name", "guarantor_id", "guarantor_signature", "company_address", "company_phone"] },
      { heading: "נחתם בנוכחות", when: { customer_type: "corporate" } },
      { fields: ["witness_name", "witness_signature"] },
      'הערות:',
      '1. בכל מחלוקת לגבי טיב העבודה ישמש השמאי מטעם חברת הביטוח, בורר מכריע ויש לראות במסמך זה הסכם בוררות.',
      '2. סמכות שיפוט בלעדית בכל תובענה בנוגע להזמנה, תהיה באשקלון ו/או בבית המשפט המחוזי ב"ש.',
    ],
    summaryField: ["private_name", "company_name"],
    captionPrefix: "הזמנת עבודה חתומה",
    example: 'כתבו "הזמנת עבודה" ואחריו סוג לקוח (פרטי/תאגיד), שם, ת"ז או ח.פ, כתובת, טלפון, מייל, תיאור העבודה וחברת הביטוח',
  },
]);

export const DEFAULT_SECTION = "פרטי הלקוח";

export function getFormDefinition(id) {
  return FORM_DEFINITIONS.find(def => def.id === id) || null;
}

/** The form a bot message asks for, when the message starts with one of its triggers. */
export function findFormByTrigger(text) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  return FORM_DEFINITIONS.find(def => def.triggers.some(trigger => normalized.startsWith(trigger))) || null;
}

/** Signature and image fields carry files, not text values. */
export const isFileField = field => field.type === "signature" || field.type === "image";

const matches = (when, values) => !when || Object.entries(when).every(([key, value]) => values?.[key] === value);

/** True when the field exists for the current choice values. */
export const isFieldVisible = (field, values) => matches(field.when, values);

/** The fields that exist for the current choice values, in definition order. */
export const visibleFields = (def, values) => def.fields.filter(field => isFieldVisible(field, values));

/** The text values with every field that does not exist for the current choices emptied. */
export function onlyVisibleValues(def, values) {
  return Object.fromEntries(def.fields.filter(field => !isFileField(field))
    .map(field => [field.key, isFieldVisible(field, values) ? values?.[field.key] ?? "" : ""]));
}

/** How a value is printed: the option label for choices, the value itself otherwise. */
export function fieldDisplayValue(field, value) {
  if (field?.type === "choice") return field.options.find(option => option.value === value)?.label ?? String(value ?? "");
  return String(value ?? "");
}

/** The caption summary: the first visible, non-empty summary field. */
export function formSummary(def, values) {
  const keys = [].concat(def.summaryField || []);
  for (const key of keys) {
    const field = def.fields.find(f => f.key === key);
    if (field && isFieldVisible(field, values) && values?.[key]) return values[key];
  }
  return "";
}

/**
 * The legal text and details with values filled in, in print order:
 * [{ text, heading, image, signature }], where `image` is the key of a signature or image field shown
 * after the text, and `signature` is true when that field is a signature.
 */
export function renderFormBody(def, values) {
  const byKey = Object.fromEntries(def.fields.map(field => [field.key, field]));
  const lines = [];
  const imageLine = (text, field) => ({ text, heading: false, image: field.key, signature: field.type === "signature" });
  for (const entry of def.body) {
    if (typeof entry === "string") {
      const text = entry.replace(/\{(\w+)\}/g, (_, key) => fieldDisplayValue(byKey[key], values?.[key]));
      const marker = /\[(\w+)\]/.exec(text);
      const field = marker && byKey[marker[1]];
      lines.push(field && isFileField(field)
        ? imageLine(text.replace(marker[0], "").trim(), field)
        : { text, heading: false, image: null, signature: false });
      continue;
    }
    if (!matches(entry.when, values)) continue;
    if (entry.heading) {
      lines.push({ text: entry.heading, heading: true, image: null, signature: false });
      continue;
    }
    for (const key of entry.fields || []) {
      const field = byKey[key];
      if (!field || !isFieldVisible(field, values)) continue;
      if (isFileField(field)) { lines.push(imageLine(field.label, field)); continue; }
      const value = fieldDisplayValue(field, values?.[key]);
      if (!value && !field.required) continue;
      lines.push({ text: `${field.label}: ${value}`, heading: false, image: null, signature: false });
    }
  }
  return lines;
}
