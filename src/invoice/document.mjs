// Tax invoice (AccountBook document type 305): amounts, document JSON and total checks.
// Money is held in agorot (integers) and converted to NIS only when the document is written.

import crypto from "node:crypto";

export const INVOICE_FORM_ID = "invoice";
export const DOC_TYPE_TAX_INVOICE = 305;
export const RANDOM_CLIENT_NUMBER = 200000;
export const DEFAULT_VAT_RATE = 18;
export const MAX_LINES = 30;
const MAX_AGOROT = 1_000_000_000; // 10,000,000 NIS

const LIMITS = { name: 60, address: 60, city: 40, detail: 150 };

const clean = (value, max) => String(value ?? "")
  .replace(/[\u0000-\u001F\u007F‎‏‪-‮]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

/** "1,200.50", "₪ 300", "1.200,50" -> agorot, or null when it is not a positive amount. */
export function parseAgorot(text) {
  let s = String(text ?? "").replace(/[‎‏\s₪]|ש"ח|ש״ח|שקלים|שקל|ח"ש/g, "");
  if (!s) return null;
  const comma = s.lastIndexOf(","), dot = s.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma >= 0) s = /,\d{1,2}$/.test(s) && s.indexOf(",") === comma ? s.replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const agorot = Math.round(Number(s) * 100);
  return agorot > 0 && agorot <= MAX_AGOROT ? agorot : null;
}

/** A positive quantity with up to 4 decimals, or null. */
export function parseQuantity(text) {
  const s = String(text ?? "").replace(/[\s‎‏]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,4})?$/.test(s)) return null;
  const qty = Number(s);
  return qty > 0 && qty <= 1_000_000 ? qty : null;
}

export function vatRateFromEnv(raw = process.env.INVOICE_VAT_RATE) {
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_VAT_RATE;
  const rate = Number(raw);
  if (!Number.isInteger(rate) || rate < 0 || rate > 50) throw new Error("INVOICE_VAT_RATE invalid");
  return rate;
}

const lineTotal = line => Math.round(line.qty * line.unitAgorot);
const money = agorot => Number((agorot / 100).toFixed(2));

/** Customer, lines and totals as shown on the approval page. */
export function buildInvoice(data, vatRate) {
  const lines = (Array.isArray(data?.lines) ? data.lines : []).slice(0, MAX_LINES).map(line => ({
    description: clean(line.description, LIMITS.detail),
    qty: Number(line.qty),
    unitAgorot: Number(line.unitAgorot),
  }));
  if (!lines.length || lines.some(l => !l.description || !(l.qty > 0) || !Number.isInteger(l.unitAgorot) || l.unitAgorot <= 0)) {
    throw new Error("invalid lines");
  }
  const rows = lines.map(line => ({ ...line, totalAgorot: lineTotal(line) }));
  const netAgorot = rows.reduce((sum, row) => sum + row.totalAgorot, 0);
  if (netAgorot <= 0 || netAgorot > MAX_AGOROT) throw new Error("invalid total");
  const vatAgorot = Math.round(netAgorot * vatRate / 100);
  return {
    customer: {
      name: clean(data.name, LIMITS.name),
      idNumber: String(data.idNumber ?? "").replace(/\D/g, "").padStart(9, "0").slice(-9),
      address: clean(data.address, LIMITS.address),
      city: clean(data.city, LIMITS.city),
    },
    detail: clean(data.description || rows.map(r => r.description).join(", "), LIMITS.detail),
    rows, vatRate, netAgorot, vatAgorot, totalAgorot: netAgorot + vatAgorot,
  };
}

/** Page preview of an invoice. */
export function previewOf(invoice, dryRun) {
  return {
    dry_run: dryRun,
    customer: invoice.customer,
    lines: invoice.rows.map(r => ({ description: r.description, quantity: r.qty, unit_price: money(r.unitAgorot), total: money(r.totalAgorot) })),
    vat_rate: invoice.vatRate,
    total_before_vat: money(invoice.netAgorot),
    vat: money(invoice.vatAgorot),
    total: money(invoice.totalAgorot),
  };
}

const xmlAttr = value => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function productsXml(invoice, esekNum) {
  const rows = invoice.rows.map((row, i) => `<ROW DDP_LineID="${i}" DDP_EsekNum="${esekNum}" DDP_ProductNum="0" DDP_ProductDetail="${xmlAttr(row.description)}" DDP_ProductUnitMeasurementUnitCode="1" DDP_Quantity="${row.qty.toFixed(4)}" DDP_ProductCurrencyID="0" DDP_ProductUnitPrice="${(row.unitAgorot / 100).toFixed(2)}" DDP_ExchangeRate="1.0000" DDP_UnitPriceILS="${(row.unitAgorot / 100).toFixed(2)}" DDP_DiscountPercentage="0.00" DDP_DiscountSum="0.00" DDP_LineTotal="${(row.totalAgorot / 100).toFixed(2)}" SrcDocType="" SrcDocNumber="" />`);
  return `<ROWS>${rows.join("")}</ROWS>`;
}

/** dd/mm/yyyy in Israel time. */
export function producedDate(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date).map(({ type, value }) => [type, value]));
  return `${p.day}/${p.month}/${p.year}`;
}

/** The CreateDocument jsonString, in the field order of the documentation example. */
export function buildDocumentJson(invoice, { esekNum, date = new Date() }) {
  return {
    EsekNum: esekNum,
    ClientNumber: RANDOM_CLIENT_NUMBER,
    TypeCode: DOC_TYPE_TAX_INVOICE,
    PrintLanguage: 0,
    DocNumber: "",
    ClientName: invoice.customer.name,
    ClientAddress: invoice.customer.address,
    ClientCityZip: invoice.customer.city,
    ClientOsekNum: invoice.customer.idNumber,
    ProducedDateString: producedDate(date),
    SumBeforeDiscount: money(invoice.netAgorot),
    DiscountAmount: 0,
    DiscountPercentage: 0,
    TotalBeforeMaam: money(invoice.netAgorot),
    DocMaamAmount: money(invoice.vatAgorot),
    DocTotalDue: money(invoice.totalAgorot),
    DocNikuyBamakorSum: 0,
    DocUserFullName: "",
    DocDetail: invoice.detail,
    DocNotMaam: 0,
    MaamRate: invoice.vatRate,
    GeneralRemark: "",
    DocTypeRemark: "",
    DocProductsXML: productsXml(invoice, esekNum),
    DocChargesXML: "",
    DocClosureXML: "",
    DocIsSourceProduced: 0,
    DocSigned: 0,
    SourceDocID: null,
    SourceTypeCode: null,
    SourceDocNumber: null,
    DocFromApi: null,
    DocID: null,
  };
}

const cents = value => Math.round(Number(value) * 100);

/** Recompute every total from the written document and throw when anything disagrees. */
export function checkDocumentTotals(doc) {
  const xmlRows = [...String(doc.DocProductsXML).matchAll(/<ROW [^>]*?DDP_Quantity="([\d.]+)"[^>]*?DDP_UnitPriceILS="([\d.]+)"[^>]*?DDP_LineTotal="([\d.]+)"/g)];
  if (!xmlRows.length) throw new Error("totals mismatch");
  let net = 0;
  for (const [, qty, unit, total] of xmlRows) {
    if (Math.round(Number(qty) * cents(unit)) !== cents(total)) throw new Error("totals mismatch");
    net += cents(total);
  }
  const vat = Math.round(net * doc.MaamRate / 100);
  const ok = cents(doc.SumBeforeDiscount) === net && cents(doc.TotalBeforeMaam) === net
    && cents(doc.DocMaamAmount) === vat && cents(doc.DocTotalDue) === net + vat && net + vat > 0;
  if (!ok) throw new Error("totals mismatch");
}

/** Stable ClientIdentifier (alphanumeric, 40 chars) derived from the approval token. */
export const clientIdentifierFor = token => crypto.createHash("sha256").update(`invoice:${token}`).digest("hex").slice(0, 40);
