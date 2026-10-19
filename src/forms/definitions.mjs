// Signature forms as data. A new form is a new entry here: the bot trigger, the extraction hints,
// the page, the validation and the PDF are all driven by this definition. Usable in the browser and in Node.
//
// FormDefinition = {
//   id:        URL-safe id, used in /forms/<id>
//   title:     form title, shown on the page and in the PDF
//   triggers:  bot messages starting with one of these open this form
//   preamble:  lines printed above the title in the PDF
//   fields:    [{ key, label, type: "text" | "textarea" | "israeli_id", required, maxLength, hint }]
//              hint tells the extraction model what the field means
//   body:      legal text lines; {key} is replaced by the field value, [signature] marks the signature line
//   summaryField: field shown in the WhatsApp caption of the signed PDF
//   example:   how to ask for the form, shown in the bot help message
// }

export const FORM_DEFINITIONS = Object.freeze([
  {
    id: "waiver",
    title: "כתב קבלה וויתור",
    triggers: ["כתב ויתור", "כתב קבלה וויתור", "כתב קבלה ויתור"],
    preamble: ['בס"ד', 'לכבוד: שפיר שיקום נזקים בע"מ'],
    fields: [
      { key: "full_name", label: "שם מלא", type: "text", required: true, maxLength: 80, hint: "השם המלא של הלקוח שחותם על הטופס" },
      { key: "id_number", label: "מספר זהות", type: "israeli_id", required: true, maxLength: 9, hint: "מספר תעודת הזהות של הלקוח, ספרות בלבד" },
      { key: "damage_description", label: "תיאור הנזק", type: "textarea", required: true, maxLength: 400, hint: "תיאור הנזק שתוקן" },
      { key: "insurance_company", label: "חברת ביטוח", type: "text", required: true, maxLength: 60, hint: "שם חברת הביטוח של הלקוח" },
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
]);

export function getFormDefinition(id) {
  return FORM_DEFINITIONS.find(def => def.id === id) || null;
}

/** The form a bot message asks for, when the message starts with one of its triggers. */
export function findFormByTrigger(text) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  return FORM_DEFINITIONS.find(def => def.triggers.some(trigger => normalized.startsWith(trigger))) || null;
}

/** The legal text with values filled in: [{ text, signature }], `signature` marks the signature line. */
export function renderFormBody(def, values) {
  return def.body.map(line => {
    const text = line.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? ""));
    return text.includes("[signature]")
      ? { text: text.replace("[signature]", "").trim(), signature: true }
      : { text, signature: false };
  });
}
