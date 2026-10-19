// Field cleaning and validation for signature forms. Shared by the page and the server.

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

/** Keep only the definition's fields, as trimmed strings within their maximum length. */
export function cleanFormFields(def, input) {
  const values = {};
  for (const field of def.fields) {
    let value = typeof input?.[field.key] === "string" || typeof input?.[field.key] === "number" ? String(input[field.key]) : "";
    values[field.key] = field.type === "israeli_id"
      ? cleanIsraeliId(value)
      : value.replace(/\s+/g, " ").trim().slice(0, field.maxLength || 200);
  }
  return values;
}

/** Hebrew error per invalid field: { key: message }. Empty object when everything is valid. */
export function validateFormFields(def, values) {
  const errors = {};
  for (const field of def.fields) {
    const value = values[field.key] || "";
    if (field.required && !value) errors[field.key] = "שדה חובה";
    else if (value && field.type === "israeli_id" && !isValidIsraeliId(value)) errors[field.key] = "מספר זהות לא תקין";
  }
  return errors;
}
