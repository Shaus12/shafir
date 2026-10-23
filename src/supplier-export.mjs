// Excel export of saved supplier invoices for one month. Every query filters by client_id.

import { getDb } from "./db.mjs";
import { exportMonth } from "./signed-forms.mjs";
import { tableToXlsx } from "./xlsx.mjs";

export const EXPORT_INVOICES_COMMAND = /^\s*ייצוא\s+חשבוניות(?:\s+(\d{1,2})\s*[/.\-]\s*(\d{4}))?\s*$/;
export const MSG_NO_INVOICES_MONTH = "לא נמצאו חשבוניות ספקים לחודש הזה.";
export const MSG_BAD_INVOICES_MONTH = 'כתבו "ייצוא חשבוניות" או "ייצוא חשבוניות 10/2026".';
export const MSG_INVOICES_NOTE = "הנתונים נקראו אוטומטית מהמסמכים. מומלץ לבדוק חשבוניות עם הערות מול המקור.";
const MAX_INVOICES = 5000;

const num = value => (value === null || value === undefined ? null : Number(value));

/** The requested month, or the current month in Israel when none was written. Null when invalid. */
export function invoicesExportMonth(monthText, yearText, now = new Date()) {
  if (monthText) return exportMonth(monthText, yearText);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", year: "numeric", month: "numeric" })
    .formatToParts(now).map(({ type, value }) => [type, value]));
  return exportMonth(parts.month, parts.year);
}

export const invoicesFileName = month => `חשבוניות ספקים ${month.label.replace("/", "-")}.xlsx`;

/** כן / לא / חלקי from the stored match report. */
function matchedText(report) {
  if (!report || report.applicable !== true) return "לא";
  return report.all_match ? "כן" : "חלקי";
}

const sum = values => {
  const present = values.filter(value => value !== null);
  return present.length ? Math.round(present.reduce((acc, value) => acc + value, 0) * 100) / 100 : null;
};

/** Workbook bytes of the invoices of the month (by document date, else the save date), or null when there are none. */
export async function exportInvoicesXlsx(clientId, month) {
  const sql = await getDb();
  const client = String(clientId);
  const invoices = await sql`
    SELECT id, to_char(date, 'DD/MM/YYYY') AS date_text, date IS NULL AS no_date,
      to_char(created_at AT TIME ZONE 'Asia/Jerusalem', 'DD/MM/YYYY') AS saved_text,
      supplier_name, supplier_id, doc_number, subtotal, vat, total, currency, match_report
    FROM app.supplier_documents
    WHERE client_id = ${client} AND doc_type = 'invoice'
      AND COALESCE(date, (created_at AT TIME ZONE 'Asia/Jerusalem')::date) >= ${month.start}::date
      AND COALESCE(date, (created_at AT TIME ZONE 'Asia/Jerusalem')::date) < ${month.end}::date
    ORDER BY COALESCE(date, (created_at AT TIME ZONE 'Asia/Jerusalem')::date), id
    LIMIT ${MAX_INVOICES}`;
  if (!invoices.length) return null;

  const items = await sql`
    SELECT document_id, sku, description, quantity, unit, unit_price, line_total FROM app.supplier_document_items
    WHERE client_id = ${client} AND document_id IN ${sql(invoices.map(invoice => invoice.id))}
    ORDER BY document_id, id`;
  const itemsByInvoice = new Map();
  for (const item of items) {
    if (!itemsByInvoice.has(item.document_id)) itemsByInvoice.set(item.document_id, []);
    itemsByInvoice.get(item.document_id).push(item);
  }

  const dateOf = invoice => (invoice.no_date ? invoice.saved_text : invoice.date_text);
  const rows = invoices.map(invoice => {
    const notes = [
      ...(invoice.no_date ? [`ללא תאריך במסמך, נשמר ב-${invoice.saved_text}`] : []),
      ...(invoice.currency && invoice.currency !== "ILS" ? [`מטבע ${invoice.currency}`] : []),
    ];
    return [
      dateOf(invoice), invoice.supplier_name || null, invoice.supplier_id || null, invoice.doc_number || null,
      num(invoice.subtotal), num(invoice.vat), num(invoice.total), matchedText(invoice.match_report), notes.join("; ") || null,
    ];
  });
  const column = index => rows.map(row => row[index]);
  rows.push([{ value: 'סה"כ', bold: true }, null, null, null,
    { value: sum(column(4)), bold: true }, { value: sum(column(5)), bold: true }, { value: sum(column(6)), bold: true }, null, null]);

  const lineRows = invoices.flatMap(invoice => (itemsByInvoice.get(invoice.id) || []).map(item => [
    dateOf(invoice), invoice.supplier_name || null, invoice.doc_number || null, item.sku || null, item.description || null,
    num(item.quantity), item.unit || null, num(item.unit_price), num(item.line_total),
  ]));

  const workbook = tableToXlsx([
    { name: "חשבוניות", headers: ["תאריך", "ספק", 'ח.פ/ע.מ', "מספר חשבונית", 'לפני מע"מ', 'מע"מ', 'סה"כ', "הותאמה לתעודות משלוח", "הערות"], rows },
    { name: "שורות", headers: ["תאריך חשבונית", "ספק", "מספר חשבונית", 'מק"ט', "תיאור", "כמות", "יחידה", "מחיר יחידה", 'סה"כ שורה'], rows: lineRows },
  ]);
  return new Uint8Array(await workbook.arrayBuffer());
}
