// Fill-in templates for form requests that miss too many details, and reading them back.
// Built from the form definition, so every form gets a template.

import { isFileField, visibleFields, fieldDisplayValue } from "./definitions.mjs";

/** More missing details than this and the bot sends a template instead of a link. */
export const MAX_MISSING_FOR_LINK = 2;

const DIRECTION_MARKS = /[\u200E\u200F\u202A-\u202E]/g;
const normalizeLabel = label => String(label ?? "").replace(DIRECTION_MARKS, "").replace(/\s+/g, " ").trim();

/** The label a field has in the template and in "label: value" messages. */
export const templateLabel = field => field.templateLabel || field.label;

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

function templateFor(def, values) {
  const lines = visibleFields(def, values)
    .filter(field => !isFileField(field))
    .map(field => `${templateLabel(field)}: ${fieldDisplayValue(field, values[field.key])}`);
  return [def.triggers[0], ...lines].join("\n");
}

/**
 * Fill-in templates: the first trigger on its own line, then "label: value" per text field, filled with
 * what was extracted. One template per option of an empty choice that decides other fields.
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

/** True when the message is a form trigger followed by the word "ריק": an empty link is wanted. */
export function isEmptyFormRequest(def, text) {
  const normalized = normalizeLabel(text);
  return def.triggers.some(trigger => normalized.startsWith(trigger)
    && /^[\s,.:\-–]*ריק(?![\u0590-\u05FFA-Za-z0-9])/.test(normalized.slice(trigger.length)));
}

/**
 * Values written as "label: value" lines (the template format), by field key. Choice lines are read first
 * (option label or value), then the labels of the fields that exist for those choices; a label shared by
 * two existing fields is skipped. An empty value after the colon is returned as "". `base` supplies choice
 * values found elsewhere in the message.
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

  const values = {};
  for (const field of def.fields) {
    if (field.type !== "choice" || !entries.has(normalizeLabel(templateLabel(field)))) continue;
    const written = entries.get(normalizeLabel(templateLabel(field)));
    const option = field.options.find(o => o.label === written || o.value === written);
    if (option) values[field.key] = option.value;
    else if (!written) values[field.key] = "";
  }

  const fields = visibleFields(def, { ...base, ...values }).filter(field => !isFileField(field) && field.type !== "choice");
  const labelCount = new Map();
  for (const field of fields) {
    const label = normalizeLabel(templateLabel(field));
    labelCount.set(label, (labelCount.get(label) || 0) + 1);
  }
  for (const field of fields) {
    const label = normalizeLabel(templateLabel(field));
    if (entries.has(label) && labelCount.get(label) === 1) values[field.key] = entries.get(label);
  }
  return values;
}
