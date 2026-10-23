// Supplier documents over time: saves extracted invoices and delivery notes (data only, never images or PDFs),
// matches an invoice with the open delivery notes of the same supplier, and lists open delivery notes.
// Every query filters by client_id. Callers catch errors; nothing here logs values.

import { getDb } from "./db.mjs";
import { applyPricesSafely } from "./supplier-prices.mjs";
import { matchDocuments, formatMatchReport, normalizeDescription, normalizeDocNumber } from "./document-matching.mjs";

export const MSG_DUPLICATE = "המסמך הזה כבר נשמר בעבר.";
export const MSG_SAVED_WAITING = "נשמרה. ממתינה לחשבונית.";
export const MSG_NO_OPEN_NOTES = "לא נמצאו תעודות משלוח פתוחות מהספק הזה.";
export const MSG_SAVE_FAILED = "לא הצלחנו לשמור את המסמך.";
export const OPEN_NOTES_COMMAND = /^\s*תעודות\s+פתוחות[\s.!?]*$/;
const MAX_OPEN_LINES = 30;
const RECENT_DAYS = 60;
const SAVED_TYPES = new Set(["invoice", "delivery_note"]);

export const isSavedType = docType => SAVED_TYPES.has(docType);

const nameKey = name => normalizeDescription(name).replace(/(^| )(בעמ|ltd|inc)(?= |$)/g, " ").replace(/\s+/g, " ").trim();
const idKey = id => normalizeDocNumber(id);
const toNum = value => (value === null || value === undefined ? null : Number(value));

function keysOf(doc) {
  const idk = idKey(doc.supplier_id);
  const nn = nameKey(doc.supplier_name);
  return { idk, nn, supplierKey: idk ? `id:${idk}` : nn ? `name:${nn}` : "", numberKey: normalizeDocNumber(doc.doc_number) };
}

/** Insert one document with its items. Returns { id, duplicate }. */
async function insertDocument(tx, clientId, senderPhone, doc) {
  const k = keysOf(doc);
  const [row] = await tx`
    INSERT INTO app.supplier_documents (client_id, sender_phone, doc_type, supplier_name, supplier_name_normalized, supplier_id,
      supplier_id_key, supplier_key, doc_number, doc_number_key, date, currency, subtotal, vat, total, referenced_delivery_notes)
    VALUES (${clientId}, ${senderPhone || null}, ${doc.doc_type}, ${doc.supplier_name}, ${k.nn}, ${doc.supplier_id},
      ${k.idk}, ${k.supplierKey}, ${doc.doc_number}, ${k.numberKey}, ${doc.date}, ${doc.currency}, ${doc.subtotal}, ${doc.vat}, ${doc.total},
      ${tx.array(doc.referenced_delivery_notes || [])}::text[])
    ON CONFLICT DO NOTHING
    RETURNING id`;
  if (!row) {
    const [existing] = await tx`
      SELECT id FROM app.supplier_documents
      WHERE client_id = ${clientId} AND doc_type = ${doc.doc_type} AND supplier_key = ${k.supplierKey} AND doc_number_key = ${k.numberKey}`;
    return { id: existing?.id ?? null, duplicate: true };
  }
  if (doc.line_items.length) {
    await tx`INSERT INTO app.supplier_document_items ${tx(doc.line_items.map(item => ({
      client_id: clientId, document_id: row.id, description: item.description, sku: item.sku,
      quantity: item.quantity, unit: item.unit, unit_price: item.unit_price, line_total: item.line_total,
    })), "client_id", "document_id", "description", "sku", "quantity", "unit", "unit_price", "line_total")}`;
  }
  return { id: row.id, duplicate: false };
}

/** Stored delivery notes as extraction-shaped documents, for matchDocuments. */
async function loadNotes(tx, clientId, rows) {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const items = await tx`
    SELECT document_id, description, sku, quantity, unit, unit_price, line_total FROM app.supplier_document_items
    WHERE client_id = ${clientId} AND document_id IN ${tx(ids)} ORDER BY id`;
  return rows.map(row => ({
    id: row.id,
    doc_type: "delivery_note",
    doc_number: row.doc_number,
    currency: row.currency,
    referenced_delivery_notes: [],
    line_items: items.filter(item => item.document_id === row.id).map(item => ({
      description: item.description, sku: item.sku, quantity: toNum(item.quantity), unit: item.unit,
      unit_price: toNum(item.unit_price), line_total: toNum(item.line_total),
    })),
  }));
}

async function markMatched(tx, clientId, noteIds, invoiceId, report) {
  if (invoiceId !== null) await tx`UPDATE app.supplier_documents SET match_report = ${tx.json(report)}::jsonb WHERE client_id = ${clientId} AND id = ${invoiceId}`;
  if (noteIds.length) {
    await tx`UPDATE app.supplier_documents SET status = 'matched', matched_invoice_id = ${invoiceId}
      WHERE client_id = ${clientId} AND doc_type = 'delivery_note' AND status = 'open' AND id IN ${tx(noteIds)}`;
  }
}

/**
 * Save one invoice or delivery note and, for an invoice, match it with the open delivery notes of its supplier.
 * Returns { note, report }: note is the extra line for the reply, report the Hebrew matching report or "".
 */
export async function saveSingleDocument({ clientId, senderPhone, doc }) {
  const sql = await getDb();
  return sql.begin(async tx => {
    const saved = await insertDocument(tx, clientId, senderPhone, doc);
    if (saved.duplicate) return { note: MSG_DUPLICATE, report: "" };
    if (doc.doc_type === "delivery_note") return { note: MSG_SAVED_WAITING, report: "" };

    const k = keysOf(doc);
    const prices = await applyPricesSafely(tx, { clientId, invoiceId: saved.id, doc, supplierKey: k.supplierKey });
    const candidates = k.supplierKey
      ? await tx`
          SELECT id, doc_number, currency, created_at FROM app.supplier_documents
          WHERE client_id = ${clientId} AND doc_type = 'delivery_note' AND status = 'open'
            AND ((${k.idk}::text <> '' AND supplier_id_key = ${k.idk}::text)
              OR ((${k.idk}::text = '' OR supplier_id_key = '') AND ${k.nn}::text <> '' AND supplier_name_normalized = ${k.nn}::text))
          ORDER BY created_at, id FOR UPDATE`
      : [];

    const referenced = new Set(doc.referenced_delivery_notes.map(normalizeDocNumber).filter(Boolean));
    const cutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
    const used = referenced.size
      ? candidates.filter(row => referenced.has(normalizeDocNumber(row.doc_number)))
      : candidates.filter(row => new Date(row.created_at).getTime() >= cutoff);

    if (!used.length) {
      const missing = doc.referenced_delivery_notes;
      return { note: [MSG_NO_OPEN_NOTES, ...(missing.length ? [`תעודות שמופיעות בחשבונית ולא נמצאו: ${missing.join(", ")}`] : [])].join("\n"), report: "", prices };
    }
    const notes = await loadNotes(tx, clientId, used);
    const result = matchDocuments([doc, ...notes]);
    await markMatched(tx, clientId, notes.map(note => note.id), saved.id, result);
    return { note: "", report: formatMatchReport(result), prices };
  });
}

/**
 * Save every invoice and delivery note of a multi-document file. When the file itself holds one invoice and its
 * delivery notes (matchResult applicable), the report is stored on the invoice and those notes are marked matched.
 * Returns extra lines for the reply (duplicates only).
 */
export async function saveFileDocuments({ clientId, senderPhone, documents, matchResult }) {
  const sql = await getDb();
  return sql.begin(async tx => {
    const lines = [];
    const priceBlocks = [];
    const saved = [];
    for (const [index, doc] of documents.entries()) {
      if (!isSavedType(doc.doc_type)) continue;
      const result = await insertDocument(tx, clientId, senderPhone, doc);
      saved.push({ doc, ...result });
      if (result.duplicate) lines.push(`• מסמך ${index + 1}: ${MSG_DUPLICATE}`);
      else if (doc.doc_type === "invoice") {
        const prices = await applyPricesSafely(tx, { clientId, invoiceId: result.id, doc, supplierKey: keysOf(doc).supplierKey });
        if (prices) priceBlocks.push(prices);
      }
    }
    const invoice = saved.find(entry => entry.doc.doc_type === "invoice");
    const noteIds = saved.filter(entry => entry.doc.doc_type === "delivery_note" && entry.id !== null).map(entry => entry.id);
    if (matchResult?.applicable && invoice && !invoice.duplicate && invoice.id !== null) {
      await markMatched(tx, clientId, noteIds, invoice.id, matchResult);
    }
    return [...lines, ...priceBlocks];
  });
}

const displayDate = text => (text ? text : "ללא תאריך");

/** The "תעודות פתוחות" reply: open delivery notes grouped by supplier, at most 30 lines. */
export async function listOpenNotesReply(clientId) {
  const sql = await getDb();
  const rows = await sql`
    SELECT supplier_name, supplier_key, doc_number, to_char(date, 'DD/MM/YYYY') AS date_text FROM app.supplier_documents
    WHERE client_id = ${clientId} AND doc_type = 'delivery_note' AND status = 'open'
    ORDER BY supplier_name NULLS LAST, supplier_key, date NULLS LAST, id`;
  if (!rows.length) return "אין תעודות משלוח פתוחות.";

  const groups = new Map();
  for (const row of rows) {
    const key = row.supplier_key || "";
    if (!groups.has(key)) groups.set(key, { name: row.supplier_name || "ספק לא מזוהה", notes: [] });
    groups.get(key).notes.push(row);
  }
  const lines = ["*תעודות משלוח פתוחות:*"];
  let shownNotes = 0;
  outer: for (const group of groups.values()) {
    if (lines.length + 2 > MAX_OPEN_LINES) break;
    lines.push(`*${group.name}:*`);
    for (const note of group.notes) {
      if (lines.length >= MAX_OPEN_LINES) break outer;
      lines.push(`• מס' ${note.doc_number || "לא זוהה"} | ${displayDate(note.date_text)}`);
      shownNotes++;
    }
  }
  const hidden = rows.length - shownNotes;
  return hidden > 0 ? `${lines.join("\n")}\nועוד ${hidden}` : lines.join("\n");
}
