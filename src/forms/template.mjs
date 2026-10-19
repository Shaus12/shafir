// Fill-in templates for form requests that miss too many details, and reading them back.
// Built from the form definition, so every form gets a template.

import { isFileField, visibleFields, fieldDisplayValue } from "./definitions.mjs";

/** More missing details than this and the bot sends a template instead of a link. */
export const MAX_MISSING_FOR_LINK = 2;

const DIRECTION_MARKS = /[\u200E\u200F\u202A-\u202E]/g;
const SEPARATORS = "[\\s,.:\\-–]";
const normalizeLabel = label => String(label ?? "")
  .replace(DIRECTION_MARKS, "")
  .replace(/[״“”]/g, '"')
  .replace(/[׳‘’]/g, "'")
  .replace(/\s+/g, " ")
  .trim();
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The label a field has in the template (short where set). */
export const templateLabel = field => field.templateLabel || field.label;

/** Labels accepted back for a field: the template label and the original label. */
const acceptedLabels = field => [...new Set([templateLabel(field), field.label].map(normalizeLabel))];

/** Choice fields that decide which other fields exist. */
const gatingChoices = def => def.fields.filter(field => field.type === "choice" && def.fields.some(other => other.when && field.key in other.when));

const missingRequired = (def, values) =>
  visibleFields(def, values).filter(field => field.required && !isFileField(field) && !values[field.key]);

/**
 * Missing required details, signatures and images excluded. When a choice that decides other fields
 * is empty, it counts as missing plus the fewest missing fields among its options.
 */
export function missingRequiredCount(def, values) {
  const choice = gatingChoices(def).find(field => !values[field.key]);
  if (!choice) return missingRequired(def, values).length;
  return 1 + Math.min(...choice.options.map(option => missingRequiredCount(def, { ...values, [choice.key]: option.value })));
}

/** The text after the trigger the message starts with, or null when it starts with none of them. */
function afterTrigger(def, text) {
  const normalized = normalizeLabel(text);
  const trigger = def.triggers.find(t => normalized.startsWith(t));
  return trigger === undefined ? null : normalized.slice(trigger.length);
}

/** Choice values selected by a word right after the trigger ("הזמנת עבודה פרטי"). */
export function choicesFromTrigger(def, text) {
  const rest = afterTrigger(def, text);
  const values = {};
  if (rest === null) return values;
  for (const choice of gatingChoices(def)) {
    const option = choice.options.find(o => o.word && new RegExp(`^${SEPARATORS}*${escapeRegExp(o.word)}(?![\\u0590-\\u05FFA-Za-z0-9])`).test(rest));
    if (option) values[choice.key] = option.value;
  }
  return values;
}

/**
 * When a choice that decides other fields is still empty and its options have trigger words, the question
 * to ask instead of a template, e.g. 'לקוח פרטי או תאגיד? שלחו "הזמנת עבודה פרטי" או "הזמנת עבודה תאגיד".'
 */
export function choiceQuestion(def, values) {
  const choice = gatingChoices(def).find(field => !values[field.key] && field.question && field.options.every(o => o.word));
  if (!choice) return null;
  return `${choice.question} שלחו ${choice.options.map(o => `"${def.triggers[0]} ${o.word}"`).join(" או ")}.`;
}

function templateFor(def, values) {
  const words = gatingChoices(def)
    .map(choice => choice.options.find(o => o.value === values[choice.key])?.word)
    .filter(Boolean);
  const keys = def.template || def.fields.map(field => field.key);
  const fields = keys
    .map(key => def.fields.find(field => field.key === key))
    .filter(field => field && !isFileField(field) && field.type !== "choice" && visibleFields(def, values).includes(field));
  return [[def.triggers[0], ...words].join(" "), ...fields.map(field => `${templateLabel(field)}: ${fieldDisplayValue(field, values[field.key])}`)].join("\n");
}

/**
 * Fill-in templates: the trigger (with the chosen option words) on its own line, then "label: value" per
 * template field, filled with what was extracted. One template per option of an empty deciding choice.
 */
export function formTemplates(def, values) {
  let variants = [values];
  for (const choice of gatingChoices(def)) {
    variants = variants.flatMap(variant => variant[choice.key]
      ? [variant]
      : choice.options.map(option => ({ ...variant, [choice.key]: option.value })));
  }
  return [...new Set(variants.map(variant => templateFor(def, variant)))];
}

/** True when the message is a form trigger (optionally with an option word) followed by "ריק": an empty link. */
export function isEmptyFormRequest(def, text) {
  const rest = afterTrigger(def, text);
  if (rest === null) return false;
  const words = gatingChoices(def).flatMap(choice => choice.options.map(o => o.word).filter(Boolean)).map(escapeRegExp);
  const word = words.length ? `(?:(?:${words.join("|")})${SEPARATORS}+)?` : "";
  return new RegExp(`^${SEPARATORS}*${word}ריק(?![\\u0590-\\u05FFA-Za-z0-9])`).test(rest);
}

/**
 * Values written as "label: value" lines (the template format), by field key. Both the template label and
 * the original label are accepted. Choice lines are read first (option label or value), then the labels of
 * the fields that exist for those choices; a label shared by two existing fields is skipped. An empty value
 * after the colon is returned as "". `base` supplies choice values found elsewhere in the message.
 */
export function parseLabeledLines(def, text, base = {}) {
  const entries = new Map();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const match = /^\s*[-•*]?\s*([^:]+?)\s*:\s*(.*)$/.exec(raw.replace(DIRECTION_MARKS, ""));
    if (!match) continue;
    const label = normalizeLabel(match[1]);
    if (!entries.has(label)) entries.set(label, match[2].trim());
  }
  if (!entries.size) return {};
  const writtenFor = field => {
    const label = acceptedLabels(field).find(l => entries.has(l));
    return label === undefined ? undefined : entries.get(label);
  };

  const values = {};
  for (const field of def.fields) {
    if (field.type !== "choice") continue;
    const written = writtenFor(field);
    if (written === undefined) continue;
    const option = field.options.find(o => o.label === written || o.value === written || (o.word && o.word === written));
    if (option) values[field.key] = option.value;
    else if (!written) values[field.key] = "";
  }

  const fields = visibleFields(def, { ...base, ...values }).filter(field => !isFileField(field) && field.type !== "choice");
  const labelCount = new Map();
  for (const field of fields) {
    for (const label of acceptedLabels(field)) labelCount.set(label, (labelCount.get(label) || 0) + 1);
  }
  for (const field of fields) {
    const label = acceptedLabels(field).find(l => entries.has(l) && labelCount.get(l) === 1);
    if (label !== undefined) values[field.key] = entries.get(label);
  }
  return values;
}
