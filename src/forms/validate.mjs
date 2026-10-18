// Field cleaning and validation for signature forms. Shared by the page and the server.

/** Israeli ID number: up to 9 digits, padded with leading zeros, Luhn-style check digit. */
export function isValidIsraeliId(value) {
  const digits = String(value ?? "").trim();
  if (!/^\d{5,9}$/.test(digits) || /^0+$/.test(digits)) return false;
  const padded = digits.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(padded[i]) * ((i % 2) + 1);
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
    value = field.type === "israeli_id" ? value.replace(/[\s-]/g, "") : value.replace(/\s+/g, " ").trim();
    values[field.key] = value.slice(0, field.maxLength || 200);
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
