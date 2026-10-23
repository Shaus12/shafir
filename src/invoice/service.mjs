// Tax invoice approval: open a personal link, check the approval code, create the document in AccountBook
// (or show it in dry-run), and send the result to the worker on WhatsApp.
// Nothing here logs the token, credentials or customer data.

import crypto from "node:crypto";
import { sealFormToken, openFormToken, FormTokenError, formsSecretConfigured } from "../forms/token.mjs";
import { sendToWorker, sendFile } from "../agent4u-crm.mjs";
import {
  INVOICE_FORM_ID, buildInvoice, previewOf, buildDocumentJson, checkDocumentTotals, clientIdentifierFor, vatRateFromEnv,
} from "./document.mjs";
import { accountBookLive, getToken, findExistingDocument, createDocument, listCompanies, downloadPdf } from "./accountbook.mjs";

export const DRY_RUN_TITLE = "מצב בדיקה – לא הופקה חשבונית";
export const MAX_WRONG_CODES = 5;

export class InvoiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "InvoiceError";
    this.status = status;
  }
}

export const sealInvoiceToken = ({ data, clientId, workerPhone }) => sealFormToken({ formId: INVOICE_FORM_ID, fields: data, clientId, workerPhone });

function open(token) {
  if (!formsSecretConfigured()) throw new InvoiceError(500, "השירות אינו מוגדר כרגע.");
  const opened = openFormToken(token);
  if (opened.formId !== INVOICE_FORM_ID) throw new FormTokenError("invalid");
  return opened;
}

function invoiceFrom(opened) {
  try {
    return buildInvoice(opened.fields, vatRateFromEnv());
  } catch {
    throw new InvoiceError(422, "פרטי החשבונית אינם תקינים. בקשו קישור חדש.");
  }
}

const dryRunMode = () => !accountBookLive();

/** Dry-run helper: the user's companies, so the right ACCOUNTBOOK_ESEK_NUM can be chosen. Never creates a document. */
async function companiesForDryRun() {
  const missing = ["ACCOUNTBOOK_USER", "ACCOUNTBOOK_PASS"].filter(name => !String(process.env[name] ?? "").trim());
  if (missing.length) {
    console.error("AccountBook credentials not set in this environment:", missing.join(", "));
    return { error: "פרטי AccountBook לא הוגדרו" };
  }
  try {
    return { items: await listCompanies(await getToken()) };
  } catch (error) {
    if (error?.name !== "AccountBookError") throw error;
    console.error("AccountBook companies failed", error.code);
    return { error: error.detail || error.code };
  }
}

/** What the approval page shows. */
export async function openInvoice(token) {
  const opened = open(token);
  const preview = previewOf(invoiceFrom(opened), dryRunMode());
  if (!preview.dry_run) return preview;
  const companies = await companiesForDryRun();
  return companies ? { ...preview, companies } : preview;
}

const sha = value => crypto.createHash("sha256").update(String(value)).digest();
const wrongTries = new Map(); // token hash -> wrong attempts (in memory only)
const inFlight = new Set();

function codeMatches(code) {
  const expected = process.env.INVOICE_APPROVAL_CODE;
  if (!expected) throw new InvoiceError(500, "השירות אינו מוגדר כרגע.");
  return crypto.timingSafeEqual(sha(String(code ?? "")), sha(expected));
}

async function notifyWorker(clientId, text, pdf) {
  if (!process.env.AGENT4U_API_KEY || clientId === undefined || clientId === null || clientId === "") return false;
  const sent = await sendToWorker(clientId, text);
  if (pdf) await sendFile(clientId, pdf.caption, "invoice", pdf.bytes, { mime: "application/pdf", filename: pdf.filename });
  return sent;
}

/** Check the code, then create (or find) the document. Returns { dryRun, json } or { dryRun: false, docNumber }. */
export async function approveInvoice(token, code) {
  const opened = open(token);
  const invoice = invoiceFrom(opened);
  const key = sha(token).toString("hex");

  if ((wrongTries.get(key) || 0) >= MAX_WRONG_CODES) throw new InvoiceError(429, "יותר מדי ניסיונות. בקשו קישור חדש.");
  if (!codeMatches(code)) {
    const tries = (wrongTries.get(key) || 0) + 1;
    wrongTries.set(key, tries);
    throw new InvoiceError(403, tries >= MAX_WRONG_CODES ? "יותר מדי ניסיונות. בקשו קישור חדש." : "קוד האישור שגוי.");
  }
  wrongTries.delete(key);

  const dryRun = dryRunMode();
  const esekNum = dryRun ? 0 : Number(String(process.env.ACCOUNTBOOK_ESEK_NUM).trim());
  const doc = buildDocumentJson(invoice, { esekNum });
  checkDocumentTotals(doc);

  if (dryRun) {
    const json = JSON.stringify(doc, null, 2);
    await notifyWorker(opened.clientId, `${DRY_RUN_TITLE}\n\nהמסמך שהיה נשלח ל-AccountBook:\n${json}`);
    return { dryRun: true, json };
  }

  if (inFlight.has(key)) throw new InvoiceError(409, "ההפקה כבר מתבצעת. נסו שוב בעוד רגע.");
  inFlight.add(key);
  try {
    const identifier = clientIdentifierFor(token);
    const session = await getToken();
    const result = (await findExistingDocument(session, identifier)) ?? (await createDocument(session, doc, identifier));
    const pdfBytes = await downloadPdf(result.pdfUrl);
    await notifyWorker(
      opened.clientId,
      `חשבונית מס מספר ${result.docNumber} הופקה.${pdfBytes ? "" : " לא הצלחנו לצרף את קובץ ה-PDF, ניתן להוריד אותו מ-AccountBook."}`,
      pdfBytes && { bytes: pdfBytes, filename: `חשבונית-מס-${result.docNumber}.pdf`, caption: `חשבונית מס ${result.docNumber}` },
    );
    return { dryRun: false, docNumber: result.docNumber };
  } catch (error) {
    if (error?.name === "AccountBookError") {
      console.error("AccountBook invoice failed", error.code);
      throw new InvoiceError(502, "לא הצלחנו להפיק את החשבונית כרגע. נסו שוב.");
    }
    throw error;
  } finally {
    inFlight.delete(key);
  }
}
