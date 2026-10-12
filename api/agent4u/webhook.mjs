import crypto from "node:crypto";
import { extractProposedItems, formatProposedItemsReply } from "../../src/proposed-items.mjs";

export const config = {
  api: {
    bodyParser: false,
  },
};

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

  const { senderPhone, messageText, isNonText } = extractWebhookData(payload);

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

  if (isNonText) {
    return send(res, 200, { reply: "כרגע ניתן לשלוח הודעות טקסט בלבד." });
  }

  if (!messageText) {
    return send(res, 200, { reply: "כרגע ניתן לשלוח הודעות טקסט בלבד." });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not configured");
    return send(res, 500, { error: "השירות אינו מוגדר כרגע." });
  }

  try {
    const { items } = await extractProposedItems(messageText);
    const reply = formatProposedItemsReply(items);
    return send(res, 200, { reply });
  } catch (error) {
    console.error("Agent4U webhook extraction failed", error);
    return send(res, 500, { error: "אירעה תקלה בעיבוד הבקשה." });
  }
}
