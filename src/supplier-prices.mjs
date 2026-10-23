// Supplier price list built from saved invoices, with the price-deviation rule: a new unit price that deviates
// from the stored one by PRICE_ALERT_PERCENT or more is not applied until it is approved.
// Every query filters by client_id. Callers catch errors; logs carry the error type only, never prices or names.

import { getDb, logDbError } from "./db.mjs";
import { normalizeDescription, normalizeSku } from "./document-matching.mjs";
import { money } from "./document-extraction.mjs";

export const MSG_NO_PENDING = "אין חריגות מחיר פתוחות.";
export const MSG_NOT_APPROVER = "רק מאשר המחירים יכול לאשר או לדחות שינויי מחיר.";
export const MSG_NO_PRICE_FOUND = "לא נמצא מחיר בשם הזה.";
const MAX_ALERT_LINES = 15;
const MAX_SEARCH_LINES = 10;
const MAX_LIST_LINES = 30;
const DEFAULT_ALERT_PERCENT = 10;

export function priceAlertPercent(raw = process.env.PRICE_ALERT_PERCENT) {
  const value = Number(raw);
  return raw !== undefined && String(raw).trim() !== "" && Number.isFinite(value) && value > 0 ? value : DEFAULT_ALERT_PERCENT;
}

/**
 * Approve / reject commands are accepted from anyone unless PRICE_APPROVER_PHONE is set; then only from that number.
 * Both phones are passed already normalized (normalizePhone in the webhook); `approver` is "" when not set.
 */
export function isPriceApprover(phone, approver) {
  if (!approver) return true;
  return Boolean(phone) && phone === approver;
}

/** Exact price commands. Returns { type: "approve"|"reject", number } | { type: "approve_all" } | { type: "search", query } | { type: "open" } | null. */
export function parsePriceCommand(text) {
  const t = String(text ?? "").trim();
  let m;
  if (/^אשר\s+(?:הכל|הכול)[\s.!]*$/.test(t)) return { type: "approve_all" };
  if ((m = /^אשר\s+#?(\d{1,9})[\s.!]*$/.exec(t))) return { type: "approve", number: Number(m[1]) };
  if ((m = /^דחה\s+#?(\d{1,9})[\s.!]*$/.exec(t))) return { type: "reject", number: Number(m[1]) };
  if (/^חריגות\s+פתוחות[\s.!?]*$/.test(t)) return { type: "open" };
  if ((m = /^מחיר\s+(.+?)\s*$/.exec(t))) return { type: "search", query: m[1] };
  return null;
}

const unitKey = unit => normalizeDescription(unit);
const label = row => row.description || row.sku || "פריט";
const percentText = percent => `${percent >= 0 ? "+" : "-"}${Math.abs(percent).toFixed(1).replace(/\.0$/, "")}%`;
const currencyOf = row => row.currency || "ILS";
const changeLine = row => {
  const unitDiffers = row.note === "יחידה שונה";
  const from = money(Number(row.old_price), currencyOf(row));
  const to = money(Number(row.new_price), currencyOf(row));
  const detail = unitDiffers ? `${from}${row.unit ? ` (${row.unit})` : ""} → ${to}${row.new_unit ? ` (${row.new_unit})` : ""} – יחידה שונה`
    : `${from} → ${to} (${percentText(Number(row.percent))})`;
  return `#${row.id} ${label(row)}: ${detail}`;
};

/**
 * Apply the unit prices of a newly saved invoice inside the caller's transaction.
 * Returns the reply text: the deviations block and the automatic-update summary, or "".
 */
async function applyInvoicePrices(tx, { clientId, invoiceId, doc, supplierKey }) {
  const threshold = priceAlertPercent();
  const currency = doc.currency || "ILS";
  const lines = new Map();
  for (const line of doc.line_items) {
    const price = Number(line.unit_price);
    const sku = normalizeSku(line.sku);
    const descriptionKey = normalizeDescription(line.description);
    const itemKey = sku || descriptionKey;
    if (!itemKey || line.unit_price === null || !(price > 0) || lines.has(itemKey)) continue;
    lines.set(itemKey, { ...line, price, itemKey, descriptionKey });
  }
  if (!lines.size) return "";

  await tx`SELECT pg_advisory_xact_lock(hashtext(${`price_changes:${clientId}`}))`;
  const [{ next }] = await tx`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM app.price_changes WHERE client_id = ${clientId}`;
  let nextId = Number(next);
  let updated = 0;
  const pending = [];

  for (const line of lines.values()) {
    const [stored] = await tx`
      SELECT price, unit, description, sku FROM app.supplier_prices
      WHERE client_id = ${clientId} AND supplier_key = ${supplierKey} AND item_key = ${line.itemKey} FOR UPDATE`;
    if (!stored) {
      await tx`
        INSERT INTO app.supplier_prices (client_id, supplier_key, supplier_name, item_key, sku, description, description_key, unit, currency,
          price, source, last_invoice_id, last_date)
        VALUES (${clientId}, ${supplierKey}, ${doc.supplier_name}, ${line.itemKey}, ${line.sku}, ${line.description}, ${line.descriptionKey},
          ${line.unit}, ${currency}, ${line.price}, 'invoice', ${invoiceId}, ${doc.date})`;
      continue;
    }
    const oldPrice = Number(stored.price);
    const unitDiffers = Boolean(unitKey(line.unit) && unitKey(stored.unit) && unitKey(line.unit) !== unitKey(stored.unit));
    const percent = ((line.price - oldPrice) / oldPrice) * 100;
    const record = (status, extra = {}) => tx`
      INSERT INTO app.price_changes (client_id, id, supplier_key, item_key, old_price, new_price, new_unit, percent, note, invoice_id, status)
      VALUES (${clientId}, ${nextId}, ${supplierKey}, ${line.itemKey}, ${oldPrice}, ${line.price}, ${extra.newUnit ?? null},
        ${extra.percent ?? null}, ${extra.note ?? null}, ${invoiceId}, ${status})`;

    if (unitDiffers) {
      await record("pending", { newUnit: line.unit, note: "יחידה שונה" });
      pending.push({ id: nextId++, old_price: oldPrice, new_price: line.price, percent: null, note: "יחידה שונה", unit: stored.unit, new_unit: line.unit, description: stored.description, sku: stored.sku, currency });
    } else if (Math.abs(percent) >= threshold) {
      await record("pending", { percent });
      pending.push({ id: nextId++, old_price: oldPrice, new_price: line.price, percent, note: null, unit: stored.unit, new_unit: null, description: stored.description, sku: stored.sku, currency });
    } else if (line.price !== oldPrice) {
      await record("auto", { percent });
      nextId++;
      await tx`
        UPDATE app.supplier_prices SET price = ${line.price}, last_invoice_id = ${invoiceId}, last_date = ${doc.date}, updated_at = now()
        WHERE client_id = ${clientId} AND supplier_key = ${supplierKey} AND item_key = ${line.itemKey}`;
      updated++;
    }
  }

  const blocks = [];
  if (pending.length) {
    const shown = pending.slice(0, MAX_ALERT_LINES).map(row => `• ${changeLine(row)}`);
    const hidden = pending.length - MAX_ALERT_LINES;
    blocks.push([
      `⚠️ חריגות מחיר (מעל ${threshold}%):`,
      ...shown,
      ...(hidden > 0 ? [`ועוד ${hidden}`] : []),
      "",
      `לאישור: "אשר ${pending[0].id}" / "דחה ${pending[0].id}" / "אשר הכל"`,
    ].join("\n"));
  }
  if (updated) blocks.push(`עודכנו ${updated} מחירים במחירון.`);
  return blocks.join("\n\n");
}

/** Same as applyInvoicePrices, but a failure here never stops the invoice from being saved. */
export async function applyPricesSafely(tx, args) {
  if (!args.supplierKey) return "";
  try {
    return await tx.savepoint(sp => applyInvoicePrices(sp, args));
  } catch (error) {
    logDbError("Supplier prices update failed", error);
    return "";
  }
}

const PENDING_SELECT = (tx, clientId, extra) => tx`
  SELECT c.id, c.supplier_key, c.item_key, c.old_price, c.new_price, c.new_unit, c.percent, c.note, c.invoice_id,
    p.description, p.sku, p.supplier_name, p.unit, p.currency
  FROM app.price_changes c
  JOIN app.supplier_prices p ON p.client_id = c.client_id AND p.supplier_key = c.supplier_key AND p.item_key = c.item_key
  WHERE c.client_id = ${clientId} AND c.status = 'pending' ${extra}
  ORDER BY c.id FOR UPDATE OF c`;

async function decide(tx, clientId, row, approve, phone) {
  if (approve) {
    await tx`
      UPDATE app.supplier_prices SET price = ${row.new_price}, unit = COALESCE(${row.new_unit}, unit), last_invoice_id = ${row.invoice_id},
        last_date = (SELECT date FROM app.supplier_documents WHERE client_id = ${clientId} AND id = ${row.invoice_id}), updated_at = now()
      WHERE client_id = ${clientId} AND supplier_key = ${row.supplier_key} AND item_key = ${row.item_key}`;
  }
  await tx`
    UPDATE app.price_changes SET status = ${approve ? "approved" : "rejected"}, decided_by_phone = ${phone || null}, decided_at = now()
    WHERE client_id = ${clientId} AND id = ${row.id}`;
}

/** Run "אשר <n>", "דחה <n>" or "אשר הכל" and return the reply. `allowed` comes from isPriceApprover. */
export async function decidePriceChanges({ clientId, command, phone, allowed }) {
  if (!allowed) return MSG_NOT_APPROVER;
  const sql = await getDb();
  const client = String(clientId);
  return sql.begin(async tx => {
    if (command.type === "approve_all") {
      const rows = await PENDING_SELECT(tx, client, tx``);
      if (!rows.length) return MSG_NO_PENDING;
      for (const row of rows) await decide(tx, client, row, true, phone);
      const shown = rows.slice(0, MAX_LIST_LINES).map(row => `• ${changeLine(row)}`);
      return [`✅ אושרו ${rows.length} שינויי מחיר והמחירון עודכן:`, ...shown, ...(rows.length > MAX_LIST_LINES ? [`ועוד ${rows.length - MAX_LIST_LINES}`] : [])].join("\n");
    }
    const [row] = await PENDING_SELECT(tx, client, tx`AND c.id = ${command.number}`);
    if (!row) return `שינוי מחיר #${command.number} לא נמצא או שכבר טופל.`;
    const approve = command.type === "approve";
    await decide(tx, client, row, approve, phone);
    return approve
      ? `✅ אושר: ${changeLine(row)}. המחירון עודכן.`
      : `❌ נדחה: #${row.id} ${label(row)}. המחיר נשאר ${money(Number(row.old_price), currencyOf(row))}.`;
  });
}

const dateText = value => {
  if (!value) return "ללא תאריך";
  const [y, m, d] = String(value).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

/** "מחיר <text>": the price list by SKU or description (contains), at most 10 lines. */
export async function searchPricesReply(clientId, query) {
  const needle = normalizeDescription(query);
  const skuNeedle = normalizeSku(query);
  if (!needle && !skuNeedle) return MSG_NO_PRICE_FOUND;
  const sql = await getDb();
  const rows = await sql`
    SELECT description, sku, supplier_name, unit, currency, price, to_char(COALESCE(last_date, updated_at::date), 'DD/MM/YYYY') AS date_text
    FROM app.supplier_prices
    WHERE client_id = ${String(clientId)}
      AND ((${needle}::text <> '' AND strpos(description_key, ${needle}::text) > 0)
        OR (${skuNeedle}::text <> '' AND strpos(upper(regexp_replace(COALESCE(sku, ''), '\\s', '', 'g')), ${skuNeedle}::text) > 0))
    ORDER BY updated_at DESC, id DESC LIMIT ${MAX_SEARCH_LINES}`;
  if (!rows.length) return MSG_NO_PRICE_FOUND;
  return rows.map(row =>
    `• ${label(row)}${row.sku && row.description ? ` (מק"ט ${row.sku})` : ""} | ${row.supplier_name || "ספק לא מזוהה"} | ${money(Number(row.price), currencyOf(row))}${row.unit ? ` ל${row.unit}` : ""} | ${row.date_text}`).join("\n");
}

/** "חריגות פתוחות": the pending price changes. */
export async function openPriceChangesReply(clientId) {
  const sql = await getDb();
  const rows = await sql`
    SELECT c.id, c.old_price, c.new_price, c.new_unit, c.percent, c.note, p.description, p.sku, p.supplier_name, p.unit, p.currency
    FROM app.price_changes c
    JOIN app.supplier_prices p ON p.client_id = c.client_id AND p.supplier_key = c.supplier_key AND p.item_key = c.item_key
    WHERE c.client_id = ${String(clientId)} AND c.status = 'pending' ORDER BY c.id`;
  if (!rows.length) return MSG_NO_PENDING;
  const lines = rows.slice(0, MAX_LIST_LINES).map(row => `• ${changeLine(row)} | ${row.supplier_name || "ספק לא מזוהה"}`);
  return [`*חריגות מחיר פתוחות:*`, ...lines, ...(rows.length > MAX_LIST_LINES ? [`ועוד ${rows.length - MAX_LIST_LINES}`] : []), "", 'לאישור: "אשר <מספר>" / "דחה <מספר>" / "אשר הכל"'].join("\n");
}
