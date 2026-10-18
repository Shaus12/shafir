// Personal form links: the form id, prefilled fields, client id, worker phone and expiry, sealed with
// AES-256-GCM so the URL carries no readable personal data and cannot be altered.

import crypto from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const FORM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class FormTokenError extends Error {
  constructor(code) {
    super(code);
    this.name = "FormTokenError";
    this.code = code;
  }
}

/** True when FORMS_SECRET is long enough to derive a key from. */
export function formsSecretConfigured(secret = process.env.FORMS_SECRET) {
  return typeof secret === "string" && secret.length >= 32;
}

function deriveKey(secret) {
  if (!formsSecretConfigured(secret)) throw new FormTokenError("not_configured");
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), Buffer.from("shafir-forms-token-v1"), 32));
}

/** Seal { formId, fields, clientId, workerPhone } into a URL-safe token valid for 7 days. */
export function sealFormToken({ formId, fields, clientId, workerPhone }, { secret = process.env.FORMS_SECRET, now = Date.now() } = {}) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify({ f: formId, d: fields, c: clientId, p: workerPhone || "", x: now + FORM_TOKEN_TTL_MS }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/** Open a token. Throws FormTokenError with code "invalid", "expired" or "not_configured". */
export function openFormToken(token, { secret = process.env.FORMS_SECRET, now = Date.now() } = {}) {
  const key = deriveKey(secret);
  const raw = typeof token === "string" && /^[A-Za-z0-9_-]+$/.test(token) ? Buffer.from(token, "base64url") : Buffer.alloc(0);
  if (raw.length <= 1 + IV_BYTES + TAG_BYTES || raw[0] !== VERSION) throw new FormTokenError("invalid");
  let payload;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(1, 1 + IV_BYTES));
    decipher.setAuthTag(raw.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new FormTokenError("invalid");
  }
  if (!payload || typeof payload.f !== "string" || typeof payload.x !== "number") throw new FormTokenError("invalid");
  if (payload.x < now) throw new FormTokenError("expired");
  return { formId: payload.f, fields: payload.d || {}, clientId: payload.c, workerPhone: payload.p || "", expiresAt: payload.x };
}
