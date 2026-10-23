// Filing of signed forms: the PDF goes to a private Supabase Storage bucket, the extracted text fields to
// app.signed_forms. Server side only. SUPABASE_URL / SUPABASE_SECRET_KEY are never logged or sent anywhere
// but Supabase. Every query filters by client_id. Callers catch errors and log the type only.

import crypto from "node:crypto";
import { getDb } from "./db.mjs";
import { getFormDefinition, isFileField, fieldDisplayValue } from "./forms/definitions.mjs";
import { tableToXlsx } from "./xlsx.mjs";

export const BUCKET = "signed-forms";
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
export const MSG_ALREADY_SIGNED = "הטופס הזה כבר נחתם.";
export const MSG_NOT_FILED = "שימו לב: הטופס לא נשמר בתיוק.";
export const MSG_NO_FORMS_FOUND = "לא נמצאו טפסים בשם הזה.";
export const FIND_FORMS_COMMAND = /^\s*טפסים\s+של\s+(.+?)\s*$/;
export const EXPORT_FORMS_COMMAND = /^\s*ייצוא\s+טפסים(?:\s+(\d{1,2})\s*[/.\-]\s*(\d{4}))?\s*$/;
export const MAX_FOUND_LISTED = 10;
export const MAX_FOUND_SENT = 5;
const MAX_EXPORT_ROWS = 5000;

export class StorageError extends Error {
  constructor(code) {
    super(code);
    this.name = "StorageError";
    this.code = code;
  }
}

export function storageConfigured() {
  return /^https:\/\//.test(String(process.env.SUPABASE_URL ?? "").trim()) && Boolean(String(process.env.SUPABASE_SECRET_KEY ?? "").trim());
}

function request(path, { method = "GET", headers = {}, body } = {}) {
  if (!storageConfigured()) throw new StorageError("not_configured");
  const key = String(process.env.SUPABASE_SECRET_KEY).trim();
  const base = String(process.env.SUPABASE_URL).trim().replace(/\/+$/, "");
  return fetch(`${base}/storage/v1/${path}`, {
    method,
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => {
    throw new StorageError("network");
  });
}

const objectPath = path => path.split("/").map(encodeURIComponent).join("/");

let bucketReady;

/** Create the private PDF-only bucket when it does not exist yet. */
async function ensureBucket() {
  bucketReady ??= (async () => {
    const found = await request(`bucket/${BUCKET}`);
    if (found.ok) return;
    if (found.status !== 404 && found.status !== 400) throw new StorageError(`bucket_${found.status}`);
    const created = await request("bucket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_PDF_BYTES, allowed_mime_types: ["application/pdf"] }),
    });
    if (!created.ok && created.status !== 409) throw new StorageError(`bucket_${created.status}`);
  })().catch(error => {
    bucketReady = undefined;
    throw error;
  });
  return bucketReady;
}

async function uploadPdf(path, bytes) {
  await ensureBucket();
  const response = await request(`object/${BUCKET}/${objectPath(path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "x-upsert": "false" },
    body: bytes,
  });
  if (!response.ok) throw new StorageError(`upload_${response.status}`);
}

/** The stored PDF bytes. */
export async function downloadFormPdf(path) {
  const response = await request(`object/${BUCKET}/${objectPath(path)}`);
  if (!response.ok) throw new StorageError(`download_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function removeObject(path) {
  try {
    await request(`object/${BUCKET}/${objectPath(path)}`, { method: "DELETE" });
  } catch {}
}

export const tokenHash = token => crypto.createHash("sha256").update(`signed-form:${token}`).digest("hex");

const normalizeName = text => String(text ?? "").normalize("NFKC").toLowerCase()
  .replace(/["'״׳]/g, "").replace(/\p{P}+/gu, " ").replace(/\s+/g, " ").trim();

const clientKey = clientId => String(clientId);

export async function isFormSigned(clientId, hash) {
  const sql = await getDb();
  const rows = await sql`SELECT 1 FROM app.signed_forms WHERE client_id = ${clientKey(clientId)} AND token_hash = ${hash} LIMIT 1`;
  return rows.length > 0;
}

/**
 * Upload the PDF and insert the row. Returns { duplicate: true } when the token already has a form
 * (nothing is kept then), otherwise { path }. Throws StorageError or a database error.
 */
export async function fileSignedForm({ clientId, def, customerName, values, pdf, contentHash, workerPhone, hash, signedAt }) {
  if (pdf.length > MAX_PDF_BYTES) throw new StorageError("too_large");
  const mm = String(signedAt.getUTCMonth() + 1).padStart(2, "0");
  const path = `${clientKey(clientId)}/${def.id}/${signedAt.getUTCFullYear()}/${mm}/${crypto.randomUUID()}.pdf`;
  await uploadPdf(path, pdf);
  try {
    const sql = await getDb();
    const rows = await sql`
      INSERT INTO app.signed_forms (client_id, form_id, form_title, customer_name, customer_name_normalized, fields,
        storage_path, content_hash, worker_phone, token_hash, signed_at)
      VALUES (${clientKey(clientId)}, ${def.id}, ${def.title}, ${customerName}, ${normalizeName(customerName)}, ${sql.json(values)}::jsonb,
        ${path}, ${contentHash}, ${workerPhone || null}, ${hash}, ${signedAt})
      ON CONFLICT (client_id, token_hash) DO NOTHING
      RETURNING id`;
    if (!rows.length) {
      await removeObject(path);
      return { duplicate: true };
    }
    return { path };
  } catch (error) {
    await removeObject(path);
    throw error;
  }
}

/** Undo filing when the form could not be delivered, so the signer can sign again. Best effort. */
export async function unfileSignedForm({ clientId, hash, path }) {
  try {
    const sql = await getDb();
    await sql`DELETE FROM app.signed_forms WHERE client_id = ${clientKey(clientId)} AND token_hash = ${hash}`;
  } catch {}
  await removeObject(path);
}

/** Signed forms whose customer name contains the query, newest first, at most 10. */
export async function findSignedForms(clientId, query) {
  const needle = normalizeName(query);
  if (!needle) return [];
  const sql = await getDb();
  return sql`
    SELECT customer_name, form_title, storage_path, to_char(signed_at AT TIME ZONE 'Asia/Jerusalem', 'DD/MM/YYYY') AS date_text
    FROM app.signed_forms
    WHERE client_id = ${clientKey(clientId)} AND strpos(customer_name_normalized, ${needle}::text) > 0
    ORDER BY signed_at DESC, id DESC LIMIT ${MAX_FOUND_LISTED}`;
}

export function foundFormsReply(rows) {
  const sending = Math.min(rows.length, MAX_FOUND_SENT);
  return [
    `נמצאו ${rows.length} טפסים:`,
    ...rows.map(row => `• ${row.customer_name || "ללא שם"} | ${row.form_title} | ${row.date_text}`),
    "",
    rows.length > MAX_FOUND_SENT ? `שולח את ${sending} הטפסים החדשים ביותר.` : "שולח את הטפסים.",
  ].join("\n");
}

const pad2 = n => String(n).padStart(2, "0");

/** Month "10/2026" -> { start, end } as "YYYY-MM-01" strings, or null when invalid. */
export function exportMonth(monthText, yearText) {
  if (!monthText) return { start: null, end: null, label: "" };
  const month = Number(monthText), year = Number(yearText);
  if (!(month >= 1 && month <= 12) || year < 2000 || year > 2100) return null;
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return { start: `${year}-${pad2(month)}-01`, end: `${next.year}-${pad2(next.month)}-01`, label: `${pad2(month)}/${year}` };
}

const columnsOf = def => {
  const fields = def.fields.filter(field => !isFileField(field));
  const counts = new Map();
  for (const field of fields) counts.set(field.label, (counts.get(field.label) || 0) + 1);
  return fields.map(field => {
    let header = field.label;
    if (counts.get(field.label) > 1 && field.when) {
      const [[key, value]] = Object.entries(field.when);
      const option = def.fields.find(f => f.key === key)?.options?.find(o => o.value === value);
      if (option) header = `${field.label} (${option.label})`;
    }
    return { field, header };
  });
};

/** Excel workbook bytes of the signed forms (all time, or one month), one sheet per form type. Null when none. */
export async function exportSignedFormsXlsx(clientId, month) {
  const sql = await getDb();
  const rows = await sql`
    SELECT form_id, form_title, customer_name, fields, worker_phone,
      to_char(signed_at AT TIME ZONE 'Asia/Jerusalem', 'DD/MM/YYYY') AS date_text
    FROM app.signed_forms
    WHERE client_id = ${clientKey(clientId)}
      AND (${month.start}::text IS NULL OR (signed_at AT TIME ZONE 'Asia/Jerusalem' >= ${month.start}::timestamp
        AND signed_at AT TIME ZONE 'Asia/Jerusalem' < ${month.end}::timestamp))
    ORDER BY form_id, signed_at, id LIMIT ${MAX_EXPORT_ROWS}`;
  if (!rows.length) return null;

  const byForm = new Map();
  for (const row of rows) {
    if (!byForm.has(row.form_id)) byForm.set(row.form_id, []);
    byForm.get(row.form_id).push(row);
  }
  const sheets = [...byForm].map(([formId, formRows]) => {
    const def = getFormDefinition(formId);
    const columns = def ? columnsOf(def) : [];
    return {
      name: formRows[0].form_title,
      headers: ["תאריך", "שם לקוח", ...columns.map(column => column.header), "טלפון העובד"],
      rows: formRows.map(row => [
        row.date_text,
        row.customer_name,
        ...columns.map(({ field }) => fieldDisplayValue(field, row.fields?.[field.key] ?? "")),
        row.worker_phone || "",
      ]),
    };
  });
  return new Uint8Array(await tableToXlsx(sheets).arrayBuffer());
}
