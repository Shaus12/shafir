import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { extractProposedItems, formatProposedItemsReply, SUBCHAPTER_MAP } from "../../src/proposed-items.mjs";
import { wantsSkn, isSknOnlyRequest, findLastItems, historyFrom, withoutHistory, SKN_HINT, NO_RECENT_ITEMS } from "../../src/items-history.mjs";
import { isInvoiceRequest, extractInvoice, invoiceTemplate } from "../../src/invoice/extract.mjs";
import { sealInvoiceToken } from "../../src/invoice/service.mjs";
import { quoteToSkn } from "../../src/skn/model.mjs";
import { quoteToXlsx, XLSX_MIME } from "../../src/xlsx.mjs";
import {
  extractDocuments,
  formatDocumentReply,
  formatDocumentListLine,
  formatDocumentWarnings,
  detectDocumentMime,
  MAX_DOCUMENT_BYTES,
} from "../../src/document-extraction.mjs";
import { matchDocuments, formatMatchReport } from "../../src/document-matching.mjs";
import { CRM_MEDIA_URL, sendToWorker, sendFile } from "../../src/agent4u-crm.mjs";
import { findFormByTrigger, FORM_DEFINITIONS, visibleFields, isFileField } from "../../src/forms/definitions.mjs";
import { extractFormFields } from "../../src/forms/extract.mjs";
import { sealFormToken, formsSecretConfigured } from "../../src/forms/token.mjs";
import { cleanFormFields } from "../../src/forms/validate.mjs";
import {
  formTemplates,
  isEmptyFormRequest,
  missingRequiredCount,
  choiceQuestion,
  choicesFromTrigger,
  MAX_MISSING_FOR_LINK,
} from "../../src/forms/template.mjs";

export { mediaIdFrom, fileBase64, base64MatchesBytes } from "../../src/agent4u-crm.mjs";

export const config = {
  api: {
    bodyParser: false,
  },
};

const TRANSCRIPTION_MODEL = "gpt-transcribe";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_KINDS = new Set(["audio", "voice", "voice_note", "ptt"]);

const VOICE_ACK = "קיבלתי את ההקלטה, מעבד...";
const VOICE_DOWNLOAD_ERROR = "לא הצלחנו להוריד את ההקלטה. נסו לשלוח אותה שוב.";
const VOICE_TRANSCRIBE_ERROR = "לא הצלחנו לתמלל את ההקלטה. נסו להקליט שוב.";
const VOICE_PROCESS_ERROR = "לא הצלחנו לעבד את ההקלטה כרגע. נסו שוב.";

const HELP_MESSAGE = `שלום! אפשר לשלוח לי:
- תיאור עבודה בטקסט או בהקלטה (למשל: "צביעה 40 מ"ר, שני שקעים") ואחזיר סעיפים וקובץ אקסל. לקובץ SKN לבינארית כתבו בסוף: לבינארית.
- צילום או PDF של חשבונית, קבלה או תעודת משלוח, ואחזיר את הפרטים שזיהיתי.${FORM_DEFINITIONS
  .filter(def => def.example)
  .map(def => `\n- טופס לחתימה: ${def.example}, ואשלח קישור לחתימה. לקישור ריק כתבו "${def.triggers[0]} ריק".`)
  .join("")}
- חשבונית מס: כתבו "חשבונית" ואחריה שם הלקוח, ת"ז או ח"פ, כתובת, עיר, תיאור וסכום לפני מע"מ, ואשלח קישור לאישור והפקה.`;

const DOCUMENT_KINDS = new Set(["image", "photo", "document", "file", "pdf"]);
const DOC_ACK = "קיבלתי את המסמך, קורא...";
const DOC_DOWNLOAD_ERROR = "לא הצלחנו להוריד את המסמך. נסו לשלוח אותו שוב.";
const DOC_TOO_LARGE = "הקובץ גדול מדי. אפשר לשלוח קובץ עד 10MB.";
const DOC_UNSUPPORTED = "אפשר לשלוח תמונה (JPG, PNG, WEBP) או קובץ PDF בלבד.";
const DOC_PROCESS_ERROR = "לא הצלחנו לקרוא את המסמך כרגע. נסו שוב.";
const DOC_NONE_FOUND = "לא זוהה מסמך ספק בקובץ. נסו לצלם שוב, ישר ובתאורה טובה.";
const SINGLE_MESSAGE_LIMIT = 1500;
const FORM_ERROR = "לא הצלחנו ליצור את הטופס כרגע. נסו שוב.";
const INVOICE_ERROR = "לא הצלחנו להכין את החשבונית כרגע. נסו שוב.";
const FORM_TEMPLATE_REPLY = "העתיקו את ההודעה הבאה, מלאו ושלחו. מה שלא תמלאו, הלקוח ישלים בטופס.";
const TEMPLATE_DELAY_MS = 1500;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export async function getRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody, "utf8");
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const rawBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");
  const hmac = crypto.createHmac("sha256", secret).update(rawBuf);
  const expectedHex = hmac.digest("hex");
  const expectedBase64 = crypto.createHmac("sha256", secret).update(rawBuf).digest("base64");

  const headerVal = String(signatureHeader).trim();
  const hexCandidate = headerVal.startsWith("sha256=")
    ? headerVal.slice(7).trim()
    : (headerVal.startsWith("SHA256=") ? headerVal.slice(7).trim() : headerVal);

  const safeCompare = (a, b) => {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  };

  return (
    safeCompare(hexCandidate.toLowerCase(), expectedHex.toLowerCase()) ||
    safeCompare(headerVal, expectedBase64)
  );
}

export function getKeyStructure(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [getKeyStructure(value[0])];
  }
  if (typeof value === "object") {
    const struct = {};
    for (const key of Object.keys(value)) {
      struct[key] = getKeyStructure(value[key]);
    }
    return struct;
  }
  return typeof value;
}

export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";

  if (digits.startsWith("00972")) {
    digits = digits.slice(2);
  }
  if (digits.startsWith("9720")) {
    digits = "972" + digits.slice(4);
  }
  if (digits.startsWith("0") && (digits.length === 9 || digits.length === 10)) {
    digits = "972" + digits.slice(1);
  } else if (digits.length === 9 && digits.startsWith("5")) {
    digits = "972" + digits;
  }

  return digits;
}

export function isValidPhone(phone) {
  if (typeof phone !== "string") return false;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 && digits === phone;
}

export function extractWebhookData(payload) {
  let senderPhone = "";
  let messageText = "";
  let isNonText = false;
  let detectedType = "";

  if (!payload || typeof payload !== "object") {
    return { senderPhone, messageText, isNonText, detectedType };
  }

  // 1. Meta / WhatsApp Cloud API webhook shape
  if (Array.isArray(payload.entry)) {
    for (const entry of payload.entry) {
      if (Array.isArray(entry?.changes)) {
        for (const change of entry.changes) {
          const val = change?.value;
          if (val) {
            if (Array.isArray(val.messages) && val.messages.length > 0) {
              const msg = val.messages[0];
              if (!senderPhone && msg.from) senderPhone = String(msg.from);
              if (msg.type && msg.type !== "text") {
                isNonText = true;
                detectedType = msg.type;
              }
              if (msg.audio || msg.voice || msg.image || msg.video || msg.document || msg.sticker) {
                isNonText = true;
                if (!detectedType) detectedType = "media";
              }
              if (typeof msg.text === "object" && msg.text?.body) {
                messageText = msg.text.body;
              } else if (typeof msg.text === "string") {
                messageText = msg.text;
              }
            }
            if (!senderPhone && Array.isArray(val.contacts) && val.contacts.length > 0) {
              senderPhone = String(val.contacts[0]?.wa_id || "");
            }
          }
        }
      }
    }
  }

  // 2. Twilio WhatsApp webhook shape
  if (!senderPhone && payload.From) {
    senderPhone = String(payload.From);
  }
  if (payload.NumMedia && Number(payload.NumMedia) > 0) {
    isNonText = true;
    detectedType = "media";
  }
  if (!messageText && typeof payload.Body === "string") {
    messageText = payload.Body;
  }

  // 3. Recursive inspection for general / custom CRM shapes
  const phoneKeyRegex = /(^|_)(phone|from|sender|mobile|caller|wa_?id|waid|user_?phone|customer_?phone|from_?number|contact_?number|sender_?phone|author)($|_)/i;
  const mediaKeyRegex = /(^|_)(audio|voice|voice_?note|image|photo|video|document|attachment|attachments|media|file|sticker|ptt)($|_)/i;
  const textKeyRegex = /(^|_)(text|body|message|msg|content|caption|description|message_?text|body_?text)($|_)/i;
  const typeKeyRegex = /(^|_)(type|message_?type|msg_?type|content_?type)($|_)/i;

  const nonTextTypes = new Set([
    "audio", "voice", "voice_note", "ptt",
    "image", "photo", "picture",
    "video",
    "document", "doc", "pdf", "file",
    "media",
    "sticker",
    "location",
    "vcard", "contact", "contacts"
  ]);

  function walk(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 8) return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    for (const [key, val] of Object.entries(node)) {
      if (val === null || val === undefined) continue;

      if (typeKeyRegex.test(key) && typeof val === "string") {
        const lowerVal = val.toLowerCase().trim();
        if (nonTextTypes.has(lowerVal)) {
          isNonText = true;
          if (!detectedType) detectedType = lowerVal;
        }
      }

      if (mediaKeyRegex.test(key)) {
        if (typeof val === "string" && val.trim().length > 0) {
          isNonText = true;
          if (!detectedType) detectedType = key;
        } else if (typeof val === "object" && (Array.isArray(val) ? val.length > 0 : Object.keys(val).length > 0)) {
          isNonText = true;
          if (!detectedType) detectedType = key;
        } else if (typeof val === "boolean" && val) {
          isNonText = true;
          if (!detectedType) detectedType = key;
        }
      }

      if (!senderPhone && phoneKeyRegex.test(key)) {
        if (typeof val === "string" || typeof val === "number") {
          const str = String(val).trim();
          if (str.replace(/\D/g, "").length >= 7) {
            senderPhone = str;
          }
        } else if (typeof val === "object" && val !== null) {
          for (const subKey of ["phone", "number", "id", "wa_id", "waId", "mobile"]) {
            if (val[subKey] && (typeof val[subKey] === "string" || typeof val[subKey] === "number")) {
              const subStr = String(val[subKey]).trim();
              if (subStr.replace(/\D/g, "").length >= 7) {
                senderPhone = subStr;
                break;
              }
            }
          }
        }
      }

      if (!messageText && textKeyRegex.test(key)) {
        if (typeof val === "string" && val.trim().length > 0) {
          messageText = val.trim();
        } else if (typeof val === "object" && val !== null) {
          for (const subKey of ["body", "text", "content", "msg"]) {
            if (typeof val[subKey] === "string" && val[subKey].trim().length > 0) {
              messageText = val[subKey].trim();
              break;
            }
          }
        }
      }

      if (typeof val === "object") {
        walk(val, depth + 1);
      }
    }
  }

  walk(payload);

  return {
    senderPhone,
    messageText: messageText.trim(),
    isNonText,
    detectedType,
  };
}

export function isVoiceNote(payload) {
  if (payload?.has_media !== true) return false;
  const kind = String(payload.media_kind || payload.media?.kind || "").toLowerCase().trim();
  return AUDIO_KINDS.has(kind) || kind.startsWith("audio/");
}

function audioFileInfo(contentType) {
  const mime = String(contentType || "").toLowerCase().split(";", 1)[0].trim();
  const known = {
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/amr": "amr",
    "audio/wav": "wav",
    "audio/webm": "webm",
  };
  if (known[mime]) return { mime, ext: known[mime] };
  return { mime: "audio/ogg", ext: "ogg" };
}

export function proposedItemsToQuote(items) {
  const subchapters = [];
  for (const item of items) {
    let sub = subchapters.find(candidate => candidate.num === item.subchapter);
    if (!sub) {
      sub = { num: item.subchapter, title: SUBCHAPTER_MAP.get(item.subchapter), items: [] };
      subchapters.push(sub);
    }
    sub.items.push({ unit: item.unit, qty: item.quantity, price: 0, description: item.description });
  }
  subchapters.sort((a, b) => a.num - b.num);
  return { title: "", projectNo: 0, buildingTitle: "", chapters: [{ num: 1, title: "אומדן עלות שיקום", subchapters }] };
}

export function quoteFileName(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `הצעה-${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}`;
}

async function sendQuoteFiles(clientId, items, { skn: withSkn = false, xlsx: withXlsx = true } = {}) {
  if (!items.length) return;
  const quote = proposedItemsToQuote(items);
  const name = quoteFileName();

  if (withXlsx) try {
    const xlsx = new Uint8Array(await quoteToXlsx(quote, { prices: false }).arrayBuffer());
    await sendFile(clientId, "קובץ אקסל", "xlsx", xlsx, { mime: XLSX_MIME, filename: `${name}.xlsx` });
  } catch (error) {
    console.error("Excel file build failed", error?.name || "Error");
  }

  if (withSkn) try {
    const skn = quoteToSkn(quote);
    await sendFile(clientId, "קובץ לבינארית", "skn", skn, { mime: "application/octet-stream", filename: `${name}.skn` });
  } catch (error) {
    console.error("SKN file build failed", error?.name || "Error");
  }
}

export function isAgent4uMediaUrl(mediaUrl) {
  try {
    const url = new URL(mediaUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "agent4u.co.il" || host.endsWith(".agent4u.co.il"));
  } catch {
    return false;
  }
}

function urlHost(mediaUrl) {
  try {
    return new URL(mediaUrl).hostname;
  } catch {
    return "invalid-url";
  }
}

async function downloadAudio(mediaUrl) {
  const headers = isAgent4uMediaUrl(mediaUrl) ? { Authorization: `Bearer ${process.env.AGENT4U_API_KEY}` } : {};
  let response;
  try {
    response = await fetch(mediaUrl, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.error("Voice note download failed", error?.name || "Error", "host:", urlHost(mediaUrl));
    return null;
  }
  if (!response.ok) {
    console.error("Voice note download failed", response.status, "host:", urlHost(mediaUrl));
    return null;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) {
    console.error("Voice note download failed", response.status, "bad size", "host:", urlHost(mediaUrl));
    return null;
  }
  return { bytes, ...audioFileInfo(response.headers.get("content-type")) };
}

async function transcribeAudio({ bytes, mime, ext }) {
  try {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), `recording.${ext}`);
    form.append("model", TRANSCRIPTION_MODEL);
    form.append("languages[]", "he");
    form.append("response_format", "json");
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      console.error("Voice note transcription failed", response.status);
      return "";
    }
    const data = await response.json();
    return typeof data?.text === "string" ? data.text.trim() : "";
  } catch (error) {
    console.error("Voice note transcription failed", error?.name || "Error");
    return "";
  }
}

function transcriptLine(transcript) {
  const oneLine = transcript.replace(/\s+/g, " ").trim();
  return `תמלול: ${oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine}`;
}

async function sendSknFromHistory(clientId, history) {
  const items = findLastItems(history);
  if (!items.length) return sendToWorker(clientId, NO_RECENT_ITEMS);
  return sendQuoteFiles(clientId, items, { skn: true, xlsx: false });
}

async function processVoiceNote(mediaUrl, clientId, history = []) {
  try {
    const audio = await downloadAudio(mediaUrl);
    if (!audio) return sendToWorker(clientId, VOICE_DOWNLOAD_ERROR);

    const transcript = await transcribeAudio(audio);
    if (!transcript) return sendToWorker(clientId, VOICE_TRANSCRIBE_ERROR);

    if (isSknOnlyRequest(transcript)) return sendSknFromHistory(clientId, history);
    const { items } = await extractProposedItems(transcript);
    const skn = wantsSkn(transcript);
    const body = items.length ? `${formatProposedItemsReply(items)}${skn ? "" : `\n\n${SKN_HINT}`}` : HELP_MESSAGE;
    await sendToWorker(clientId, `${transcriptLine(transcript)}\n\n${body}`);
    return sendQuoteFiles(clientId, items, { skn });
  } catch (error) {
    console.error("Voice note processing failed", error?.name || "Error");
    return sendToWorker(clientId, VOICE_PROCESS_ERROR);
  }
}

export function isDocumentMedia(payload) {
  if (payload?.has_media !== true) return false;
  const kind = String(payload.media_kind || payload.media?.kind || "").toLowerCase().trim();
  return DOCUMENT_KINDS.has(kind) || kind.startsWith("image/") || kind === "application/pdf";
}

async function downloadDocument(mediaId) {
  let response;
  try {
    response = await fetch(`${CRM_MEDIA_URL}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${process.env.AGENT4U_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("Document download failed", error?.name || "Error");
    return { error: DOC_DOWNLOAD_ERROR };
  }
  if (!response.ok) {
    console.error("Document download failed", response.status);
    return { error: DOC_DOWNLOAD_ERROR };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) {
    console.error("Document download failed", response.status, "empty");
    return { error: DOC_DOWNLOAD_ERROR };
  }
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    console.error("Document download failed", response.status, "too large");
    return { error: DOC_TOO_LARGE };
  }
  return { bytes };
}

async function processDocument(mediaId, clientId) {
  try {
    const download = await downloadDocument(mediaId);
    if (download.error) return sendToWorker(clientId, download.error);
    if (!detectDocumentMime(download.bytes)) return sendToWorker(clientId, DOC_UNSUPPORTED);

    const { documents } = await extractDocuments(download.bytes);
    if (!documents.length) return sendToWorker(clientId, DOC_NONE_FOUND);
    if (documents.length === 1) return sendToWorker(clientId, formatDocumentReply(documents[0]));

    const list = [`זוהו ${documents.length} מסמכים בקובץ:`, ...documents.map(formatDocumentListLine)].join("\n");
    const report = [formatMatchReport(matchDocuments(documents)), formatDocumentWarnings(documents)].filter(Boolean).join("\n\n");
    const combined = `${list}\n\n${report}`;
    if (combined.length <= SINGLE_MESSAGE_LIMIT) return sendToWorker(clientId, combined);
    await sendToWorker(clientId, list);
    return sendToWorker(clientId, report);
  } catch (error) {
    console.error("Document processing failed", error?.status || error?.name || "Error");
    return sendToWorker(clientId, DOC_PROCESS_ERROR);
  }
}

function publicBaseUrl(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `https://${host}` : "";
}

/** Each template as its own message after the webhook reply, so it can be copied cleanly. Sent once, no retry. */
async function sendFormTemplates(clientId, templates) {
  await new Promise(resolve => setTimeout(resolve, TEMPLATE_DELAY_MS));
  for (const template of templates) {
    if (!(await sendToWorker(clientId, template))) return;
  }
}

export function formLinkReply(def, fields, url, { invalid = [], empty = false } = {}) {
  const missing = empty ? [] : visibleFields(def, fields)
    .filter(field => field.required && !isFileField(field) && !fields[field.key] && !invalid.includes(field.key))
    .map(field => field.label);
  return [
    `נוצר טופס "${def.title}" לחתימה:`,
    url,
    "",
    "שלחו את הקישור ללקוח. הקישור אישי ובתוקף ל-7 ימים. אחרי החתימה הטופס החתום יישלח לכאן כ-PDF.",
    ...(missing.length ? [`פרטים שלא זוהו והלקוח ישלים בטופס: ${missing.join(", ")}.`] : []),
    ...(invalid.length ? ["מספר הזהות שנשלח לא תקין, הלקוח ישלים אותו בטופס."] : []),
  ].join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "שיטת הבקשה אינה נתמכת." });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("Failed to read raw body", err);
    return send(res, 400, { error: "שגיאה בקריאת גוף הבקשה." });
  }

  const signature = req.headers["x-agent4u-signature"];
  const secret = process.env.AGENT4U_SHARED_SECRET;
  if (!signature || !secret || !verifySignature(rawBody, signature, secret)) {
    return send(res, 401, { error: "חתימה חסרה או שגויה." });
  }

  let payload;
  try {
    const rawText = rawBody.toString("utf8");
    payload = JSON.parse(rawText || "{}");
  } catch (err) {
    return send(res, 400, { error: "פורמט ה-JSON אינו תקין." });
  }

  console.log("Agent4U webhook payload key structure:", JSON.stringify(getKeyStructure(payload)));

  const history = historyFrom(payload);
  const { senderPhone, messageText, isNonText } = extractWebhookData(withoutHistory(payload));

  const isDemoMode = String(process.env.AGENT4U_DEMO_MODE || "").toLowerCase() === "true" || process.env.AGENT4U_DEMO_MODE === "1";
  if (isDemoMode) {
    const demoPhone = normalizePhone(process.env.AGENT4U_DEMO_PHONE);
    if (!isValidPhone(demoPhone)) {
      return send(res, 200, { reply: "" });
    }
    const normalizedSender = normalizePhone(senderPhone);
    if (!normalizedSender || normalizedSender !== demoPhone) {
      return send(res, 200, { reply: "" });
    }
  }

  if (isVoiceNote(payload)) {
    const mediaId = payload.media?.id;
    const hasMediaId = (typeof mediaId === "string" && mediaId.trim() !== "") || typeof mediaId === "number";
    const mediaUrl = hasMediaId
      ? `${CRM_MEDIA_URL}/${encodeURIComponent(String(mediaId).trim())}`
      : String(payload.media_url || payload.media?.url || "");
    const clientId = payload.client?.id;
    if (!process.env.OPENAI_API_KEY || !process.env.AGENT4U_API_KEY) {
      console.error("OPENAI_API_KEY or AGENT4U_API_KEY is not configured");
      return send(res, 500, { error: "השירות אינו מוגדר כרגע." });
    }
    if (!/^https?:\/\//i.test(mediaUrl) || clientId === undefined || clientId === null || clientId === "") {
      return send(res, 200, { reply: VOICE_PROCESS_ERROR });
    }
    waitUntil(processVoiceNote(mediaUrl, clientId, history));
    return send(res, 200, { reply: VOICE_ACK });
  }

  if (isDocumentMedia(payload)) {
    const rawMediaId = payload.media?.id;
    const mediaId = (typeof rawMediaId === "string" || typeof rawMediaId === "number") ? String(rawMediaId).trim() : "";
    const clientId = payload.client?.id;
    if (!process.env.OPENAI_API_KEY || !process.env.AGENT4U_API_KEY) {
      console.error("OPENAI_API_KEY or AGENT4U_API_KEY is not configured");
      return send(res, 500, { error: "השירות אינו מוגדר כרגע." });
    }
    if (!mediaId || clientId === undefined || clientId === null || clientId === "") {
      return send(res, 200, { reply: DOC_PROCESS_ERROR });
    }
    waitUntil(processDocument(mediaId, clientId));
    return send(res, 200, { reply: DOC_ACK });
  }

  if (isNonText) {
    return send(res, 200, { reply: "כרגע ניתן לשלוח הודעות טקסט בלבד." });
  }

  if (!messageText) {
    return send(res, 200, { reply: "כרגע ניתן לשלוח הודעות טקסט בלבד." });
  }

  if (isSknOnlyRequest(messageText)) {
    const clientId = payload.client?.id;
    if (clientId === undefined || clientId === null || clientId === "" || !process.env.AGENT4U_API_KEY) {
      return send(res, 200, { reply: NO_RECENT_ITEMS });
    }
    const items = findLastItems(history);
    if (!items.length) return send(res, 200, { reply: NO_RECENT_ITEMS });
    waitUntil(sendQuoteFiles(clientId, items, { skn: true, xlsx: false }));
    return send(res, 200, { reply: "שולח את קובץ הבינארית..." });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not configured");
    return send(res, 500, { error: "השירות אינו מוגדר כרגע." });
  }

  if (isInvoiceRequest(messageText)) {
    const clientId = payload.client?.id;
    if (!formsSecretConfigured()) {
      console.error("FORMS_SECRET is not configured");
      return send(res, 500, { error: "השירות אינו מוגדר כרגע." });
    }
    if (clientId === undefined || clientId === null || clientId === "") {
      return send(res, 200, { reply: INVOICE_ERROR });
    }
    try {
      const baseUrl = publicBaseUrl(req);
      if (!baseUrl) throw new Error("missing host");
      const { data, missing } = await extractInvoice(messageText);
      if (missing.length) {
        waitUntil(sendFormTemplates(clientId, [invoiceTemplate(data)]));
        return send(res, 200, { reply: `${FORM_TEMPLATE_REPLY}\nחסר: ${missing.join(", ")}.` });
      }
      const token = sealInvoiceToken({ data, clientId, workerPhone: normalizePhone(senderPhone) });
      return send(res, 200, { reply: `החשבונית מוכנה לאישור:\n${baseUrl}/invoice/approve?t=${token}\n\nהקישור אישי ובתוקף ל-7 ימים. בדף תראו תצוגה מלאה, תזינו את קוד האישור ותפיקו. אחרי ההפקה החשבונית תישלח לכאן כ-PDF.` });
    } catch (error) {
      console.error("Invoice request failed", error?.status || error?.name || "Error");
      return send(res, 200, { reply: INVOICE_ERROR });
    }
  }

  const formDef = findFormByTrigger(messageText);
  if (formDef) {
    const clientId = payload.client?.id;
    if (!formsSecretConfigured()) {
      console.error("FORMS_SECRET is not configured");
      return send(res, 500, { error: "השירות אינו מוגדר כרגע." });
    }
    if (clientId === undefined || clientId === null || clientId === "") {
      return send(res, 200, { reply: FORM_ERROR });
    }
    try {
      const baseUrl = publicBaseUrl(req);
      if (!baseUrl) throw new Error("missing host");
      const empty = isEmptyFormRequest(formDef, messageText);
      const { fields, invalid, fromTemplate } = empty
        ? { fields: cleanFormFields(formDef, choicesFromTrigger(formDef, messageText)), invalid: [], fromTemplate: false }
        : await extractFormFields(formDef, messageText);
      if (!empty && !fromTemplate && missingRequiredCount(formDef, fields) > MAX_MISSING_FOR_LINK) {
        const question = choiceQuestion(formDef, fields);
        if (question) return send(res, 200, { reply: question });
        waitUntil(sendFormTemplates(clientId, formTemplates(formDef, fields)));
        return send(res, 200, { reply: FORM_TEMPLATE_REPLY });
      }
      const token = sealFormToken({ formId: formDef.id, fields, clientId, workerPhone: normalizePhone(senderPhone) });
      return send(res, 200, { reply: formLinkReply(formDef, fields, `${baseUrl}/forms/${formDef.id}?t=${token}`, { invalid, empty }) });
    } catch (error) {
      console.error("Form link failed", error?.status || error?.name || "Error");
      return send(res, 200, { reply: FORM_ERROR });
    }
  }

  try {
    const { items } = await extractProposedItems(messageText);
    const skn = wantsSkn(messageText);
    const reply = items.length ? `${formatProposedItemsReply(items)}${skn ? "" : `\n\n${SKN_HINT}`}` : HELP_MESSAGE;
    const clientId = payload.client?.id;
    if (items.length && clientId !== undefined && clientId !== null && clientId !== "" && process.env.AGENT4U_API_KEY) {
      waitUntil(sendQuoteFiles(clientId, items, { skn }));
    }
    return send(res, 200, { reply });
  } catch (error) {
    console.error("Agent4U webhook extraction failed", error);
    return send(res, 500, { error: "אירעה תקלה בעיבוד הבקשה." });
  }
}
