import { money } from "./document-extraction.mjs";

const QUANTITY_TOLERANCE = 0.001;
const PRICE_TOLERANCE = 0.01;
const MAX_LINES_PER_SECTION = 15;

export function normalizeDescription(text) {
  if (!text) return "";
  return String(text).normalize("NFKC").toLowerCase().replace(/["'״׳]/g, "").replace(/\p{P}+/gu, " ").replace(/\s+/g, " ").trim();
}

export function normalizeSku(sku) {
  if (!sku) return "";
  return String(sku).normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

export function normalizeDocNumber(number) {
  if (!number) return "";
  return String(number).normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase().replace(/^0+(?=.)/, "");
}

function sameItem(a, b) {
  if (a.sku && b.sku) return a.sku === b.sku;
  return Boolean(a.desc) && a.desc === b.desc;
}

function addToGroups(groups, line, docNumber) {
  const sku = normalizeSku(line.sku);
  const desc = normalizeDescription(line.description);
  const pairable = Boolean(sku || desc);
  let group = pairable ? groups.find(candidate => candidate.pairable && sameItem(candidate, { sku, desc })) : null;
  if (!group) {
    group = { pairable, sku, desc, description: line.description, rawSku: line.sku, quantity: 0, quantityKnown: true, prices: [], docNumbers: [] };
    groups.push(group);
  }
  if (line.quantity === null) group.quantityKnown = false;
  else group.quantity += line.quantity;
  if (line.unit_price !== null) group.prices.push(line.unit_price);
  if (docNumber && !group.docNumbers.includes(docNumber)) group.docNumbers.push(docNumber);
}

const distinct = values => values.filter((value, index) => values.findIndex(other => Math.abs(other - value) <= PRICE_TOLERANCE) === index);
const round3 = n => Math.round(n * 1000) / 1000;

function lineView(group) {
  return {
    description: group.description,
    sku: group.rawSku,
    quantity: group.quantityKnown ? round3(group.quantity) : null,
    delivery_note_numbers: group.docNumbers,
  };
}

/**
 * Compare one invoice with its delivery notes. Pure: documents in, report out.
 * Lines pair by SKU when both sides have one, otherwise by normalized description.
 * Lines that do not pair are reported, never guessed.
 */
export function matchDocuments(documents) {
  const invoices = documents.filter(doc => doc.doc_type === "invoice");
  const deliveryNotes = documents.filter(doc => doc.doc_type === "delivery_note");
  const base = {
    invoice_count: invoices.length,
    delivery_note_count: deliveryNotes.length,
    matched: [],
    quantity_differences: [],
    price_differences: [],
    invoice_only: [],
    delivery_only: [],
    missing_delivery_notes: [],
    unverified: [],
  };
  if (invoices.length !== 1 || deliveryNotes.length === 0) {
    return { ...base, applicable: false, reason: "needs_one_invoice_and_delivery_note", all_match: false };
  }

  const invoice = invoices[0];
  const invoiceGroups = [];
  for (const line of invoice.line_items) addToGroups(invoiceGroups, line, invoice.doc_number);
  const deliveryGroups = [];
  for (const note of deliveryNotes) {
    for (const line of note.line_items) addToGroups(deliveryGroups, line, note.doc_number);
  }

  const report = {
    ...base,
    applicable: true,
    reason: null,
    currency: invoice.currency || deliveryNotes.find(note => note.currency)?.currency || null,
    invoice_number: invoice.doc_number,
    delivery_note_numbers: deliveryNotes.map(note => note.doc_number),
  };

  const used = new Set();
  for (const inv of invoiceGroups) {
    const dn = inv.pairable ? deliveryGroups.find(candidate => !used.has(candidate) && candidate.pairable && sameItem(inv, candidate)) : null;
    if (!dn) {
      report.invoice_only.push(lineView(inv));
      continue;
    }
    used.add(dn);
    const view = { description: inv.description || dn.description, sku: inv.rawSku || dn.rawSku, delivery_note_numbers: dn.docNumbers };
    let clean = true;

    if (!inv.quantityKnown || !dn.quantityKnown) {
      report.unverified.push({ ...view, reason: "missing_quantity" });
      clean = false;
    } else if (Math.abs(inv.quantity - dn.quantity) > QUANTITY_TOLERANCE) {
      report.quantity_differences.push({ ...view, invoice_quantity: round3(inv.quantity), delivered_quantity: round3(dn.quantity) });
      clean = false;
    }

    if (dn.prices.length) {
      const invoicePrices = distinct(inv.prices);
      const deliveryPrices = distinct(dn.prices);
      if (!invoicePrices.length) {
        report.unverified.push({ ...view, reason: "missing_invoice_price" });
        clean = false;
      } else if (deliveryPrices.some(price => !invoicePrices.some(other => Math.abs(other - price) <= PRICE_TOLERANCE))) {
        report.price_differences.push({ ...view, invoice_unit_prices: invoicePrices, delivery_unit_prices: deliveryPrices });
        clean = false;
      }
    }

    if (clean) report.matched.push({ ...view, quantity: round3(inv.quantity), unit_price: distinct(inv.prices)[0] ?? null });
  }

  report.delivery_only = deliveryGroups.filter(group => !used.has(group)).map(lineView);

  const presentNumbers = new Set(deliveryNotes.map(note => normalizeDocNumber(note.doc_number)).filter(Boolean));
  report.missing_delivery_notes = invoice.referenced_delivery_notes.filter(number => !presentNumbers.has(normalizeDocNumber(number)));

  report.all_match = !report.quantity_differences.length && !report.price_differences.length && !report.invoice_only.length
    && !report.delivery_only.length && !report.missing_delivery_notes.length && !report.unverified.length;
  return report;
}

const quantityFormat = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 3 });
const qty = value => value === null ? "לא זוהתה" : quantityFormat.format(value);

function itemLabel(item) {
  if (item.description && item.sku) return `${item.description} (מק"ט ${item.sku})`;
  return item.description || (item.sku ? `מק"ט ${item.sku}` : "שורה ללא תיאור");
}

function section(title, entries) {
  if (!entries.length) return [];
  const shown = entries.slice(0, MAX_LINES_PER_SECTION).map(entry => `• ${entry}`);
  const hidden = entries.length - MAX_LINES_PER_SECTION;
  return ["", `*${title}:*`, ...shown, ...(hidden > 0 ? [`ועוד ${hidden}`] : [])];
}

/** The Hebrew matching report for WhatsApp. */
export function formatMatchReport(report) {
  if (!report.applicable) return "להתאמה נדרשת חשבונית אחת ולפחות תעודת משלוח אחת בקובץ.";
  if (report.all_match) return "✅ החשבונית תואמת לתעודות המשלוח.";

  const currency = report.currency;
  const prices = values => values.map(value => money(value, currency)).join(" / ");
  const notes = numbers => numbers.length ? `, ת.מ. ${numbers.join(", ")}` : "";

  return [
    "⚠️ נמצאו פערים:",
    ...section("הפרשי כמות", report.quantity_differences.map(item =>
      `${itemLabel(item)}: בחשבונית ${qty(item.invoice_quantity)}, בתעודות ${qty(item.delivered_quantity)}`)),
    ...section("הפרשי מחיר", report.price_differences.map(item =>
      `${itemLabel(item)}: בחשבונית ${prices(item.invoice_unit_prices)}, בתעודות ${prices(item.delivery_unit_prices)}`)),
    ...section("בחשבונית ואין בתעודות המשלוח", report.invoice_only.map(item =>
      `${itemLabel(item)} (כמות ${qty(item.quantity)})`)),
    ...section("בתעודות המשלוח ואין בחשבונית", report.delivery_only.map(item =>
      `${itemLabel(item)} (כמות ${qty(item.quantity)}${notes(item.delivery_note_numbers)})`)),
    ...section("תעודות שמופיעות בחשבונית ולא נמצאו בקובץ", report.missing_delivery_notes),
    ...section("לא ניתן היה להשוות", report.unverified.map(item =>
      `${itemLabel(item)}: ${item.reason === "missing_quantity" ? "חסרה כמות" : "חסר מחיר בחשבונית"}`)),
    "",
    `שורות תואמות: ${report.matched.length}`,
  ].join("\n");
}
