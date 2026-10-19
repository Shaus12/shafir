// Field cleaning and validation for signature forms. Shared by the page and the server.

import { isFileField, visibleFields } from "./definitions.mjs";

const DIRECTION_MARKS = /[\u200E\u200F\u202A-\u202E]/g;

/**
 * Israeli ID number as typed or pasted: every non-digit (dashes, spaces, direction marks) is removed and
 * the digits are padded with leading zeros to 9. More than 9 digits is returned as is so validation rejects it.
 */
export function cleanIsraeliId(value) {
  const digits = String(value ?? "").replace(/\D/g, "").slice(0, 20);
  return digits && digits.length <= 9 ? digits.padStart(9, "0") : digits;
}

/** Israeli ID check digit: weights 1,2,1,2… from the left, products over 9 minus 9, total divisible by 10. */
export function isValidIsraeliId(value) {
  const digits = cleanIsraeliId(value);
  if (digits.length !== 9 || /^0+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(digits[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

const ID_RUN = /\d(?:[\d\s\-\u2010-\u2015\u2212\u200E\u200F\u202A-\u202E]*\d)?/g;
const MIN_ID_DIGITS_IN_TEXT = 5;

/**
 * Israeli ID numbers written in free text, in order. Digit runs may contain dashes, spaces and direction
 * marks; a run that is not a valid ID as a whole is also tried word by word (an ID next to a phone number).
 * Runs shorter than 5 digits (quantities, sizes) are ignored. `invalid` counts runs with no valid ID.
 */
export function israeliIdsInText(text, { exclude = new Set() } = {}) {
  const valid = [];
  let invalid = 0;
  for (const [run] of String(text ?? "").matchAll(ID_RUN)) {
    const candidates = /\s/.test(run) ? [run, ...run.split(/\s+/)] : [run];
    let seen = false;
    let found = false;
    for (const candidate of candidates) {
      const digits = candidate.replace(/\D/g, "");
      if (digits.length < MIN_ID_DIGITS_IN_TEXT || exclude.has(digits)) continue;
      seen = true;
      if (isValidIsraeliId(digits)) {
        valid.push(cleanIsraeliId(digits));
        found = true;
        break;
      }
    }
    if (seen && !found) invalid++;
  }
  return { valid, invalid };
}

/** Phone or fax: digits only, with a leading + kept. */
export function cleanPhone(value) {
  const kept = String(value ?? "").replace(/[^\d+]/g, "").slice(0, 20);
  return kept.replace(/(?!^)\+/g, "");
}

/** Israeli phone: 0 or +972 followed by 8–9 digits. */
export const isValidPhone = value => /^(?:\+?972|0)\d{8,9}$/.test(String(value ?? ""));

export const cleanEmail = value => String(value ?? "").replace(DIRECTION_MARKS, "").replace(/\s+/g, "").slice(0, 120);

export const isValidEmail = value => /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(String(value ?? ""));

/** Company number (ח.פ): digits only, no check digit. */
export const cleanCompanyNumber = value => String(value ?? "").replace(/\D/g, "").slice(0, 20);

export const isValidCompanyNumber = value => /^\d{9}$/.test(String(value ?? ""));

/**
 * Keep only the definition's text fields, cleaned per type. Choices keep only a known option value.
 * Fields hidden by the current choice are kept (a prefill survives changing the choice); use
 * onlyVisibleValues() before printing. Signature and image fields are not text and are left out.
 */
export function cleanFormFields(def, input) {
  const values = {};
  for (const field of def.fields) {
    if (isFileField(field)) continue;
    const value = typeof input?.[field.key] === "string" || typeof input?.[field.key] === "number" ? String(input[field.key]) : "";
    switch (field.type) {
      case "israeli_id": values[field.key] = cleanIsraeliId(value); break;
      case "company_number": values[field.key] = cleanCompanyNumber(value); break;
      case "phone": values[field.key] = cleanPhone(value); break;
      case "email": values[field.key] = cleanEmail(value); break;
      case "choice": values[field.key] = field.options.some(option => option.value === value.trim()) ? value.trim() : ""; break;
      default: values[field.key] = value.replace(/\s+/g, " ").trim().slice(0, field.maxLength || 200);
    }
  }
  return values;
}

/**
 * Hebrew error per invalid text field that exists for the current choices: { key: message }.
 * Empty object when everything is valid. Signature and image fields are checked by the caller.
 */
export function validateFormFields(def, values) {
  const errors = {};
  for (const field of visibleFields(def, values)) {
    if (isFileField(field)) continue;
    const value = values[field.key] || "";
    if (!value) {
      if (field.required) errors[field.key] = field.type === "choice" ? "יש לבחור אפשרות" : "שדה חובה";
    } else if (field.type === "israeli_id" && !isValidIsraeliId(value)) errors[field.key] = "מספר זהות לא תקין";
    else if (field.type === "company_number" && !isValidCompanyNumber(value)) errors[field.key] = "ח.פ צריך להכיל 9 ספרות";
    else if (field.type === "phone" && !isValidPhone(value)) errors[field.key] = "מספר לא תקין";
    else if (field.type === "email" && !isValidEmail(value)) errors[field.key] = "כתובת אימייל לא תקינה";
  }
  return errors;
}
