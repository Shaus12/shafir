import { getFormDefinition, visibleFields, onlyVisibleValues, isFileField, formSummary } from "../../src/forms/definitions.mjs";
import { openFormToken, formsSecretConfigured, FormTokenError } from "../../src/forms/token.mjs";
import { cleanFormFields, validateFormFields } from "../../src/forms/validate.mjs";
import { renderFormPdf, formContentHash, signatureHasInk, imageDecodes, israelDateTime } from "../../src/forms/pdf.mjs";
import { sendFile } from "../../src/agent4u-crm.mjs";
import { send, readJsonBody, sendTokenError } from "../../src/forms/http.mjs";

const MAX_FILE_BYTES = 600 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** The real image type from the file's first bytes: "png", "jpeg" or null. */
function detectImageType(bytes) {
  if (PNG_MAGIC.every((byte, i) => bytes[i] === byte)) return "png";
  if (JPEG_MAGIC.every((byte, i) => bytes[i] === byte)) return "jpeg";
  return null;
}

/** Bytes of a base64 data URL within the size limit. The declared type is ignored; the bytes decide. */
function dataUrlBytes(dataUrl) {
  const match = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === "string" ? dataUrl : "");
  if (!match) return null;
  const bytes = Buffer.from(match[1], "base64");
  return bytes.length && bytes.length <= MAX_FILE_BYTES ? bytes : null;
}

/** Signature and image files of the visible fields, checked. Returns { files, errors }. */
async function readFiles(def, values, input) {
  const files = {};
  const errors = {};
  for (const field of visibleFields(def, values)) {
    if (!isFileField(field)) continue;
    const bytes = dataUrlBytes(input?.[field.key]);
    const type = bytes && detectImageType(bytes);
    if (field.type === "signature") {
      if (type === "png" && (await signatureHasInk(bytes))) files[field.key] = bytes;
      else if (field.required) errors[field.key] = "חסרה חתימה";
    } else if (type && (await imageDecodes(bytes))) {
      files[field.key] = bytes;
    } else if (bytes || field.required) {
      errors[field.key] = bytes ? "יש להעלות תמונה בפורמט JPG או PNG" : "יש להעלות תמונה";
    }
  }
  return { files, errors };
}

const safeFileName = text => text.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Public: sign a form. The token decides the form, the client the PDF goes to and the worker phone;
 * the signer's fields, signatures and images are validated, rendered to a PDF and sent. Nothing is stored.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "שיטת הבקשה אינה נתמכת." });
  }
  if (!formsSecretConfigured() || !process.env.AGENT4U_API_KEY) {
    console.error("FORMS_SECRET or AGENT4U_API_KEY is not configured");
    return send(res, 500, { error: "השירות אינו מוגדר כרגע." });
  }

  const body = readJsonBody(req);
  const def = getFormDefinition(body.form);
  if (!def) return send(res, 404, { error: "הטופס לא נמצא." });

  try {
    const token = openFormToken(body.token);
    if (token.formId !== def.id) throw new FormTokenError("invalid");

    const values = onlyVisibleValues(def, cleanFormFields(def, body.fields));
    const { files, errors: fileErrors } = await readFiles(def, values, body.files);
    const errors = { ...validateFormFields(def, values), ...fileErrors };
    if (Object.keys(errors).length) {
      const onlySignatures = Object.keys(errors).every(key => def.fields.find(field => field.key === key)?.type === "signature");
      return send(res, 400, { error: onlySignatures ? "יש לחתום בתיבת החתימה." : "יש לתקן את השדות המסומנים.", fields: errors });
    }

    const signedAt = new Date();
    const hash = formContentHash({ def, values, files, signedAt, workerPhone: token.workerPhone });
    const pdf = await renderFormPdf({ def, values, files, signedAt, workerPhone: token.workerPhone, hash });

    const filename = `${safeFileName(`${def.title} ${israelDateTime(signedAt).replace(/[/:]/g, "-")}`)}.pdf`;
    const summary = formSummary(def, values);
    const prefix = def.captionPrefix || `${def.title} חתום`;
    const caption = summary ? `${prefix}: ${summary}` : prefix;
    const sent = await sendFile(token.clientId, caption, "form-pdf", pdf, { mime: "application/pdf", filename });
    if (!sent) return send(res, 502, { error: "הטופס נחתם אך השליחה נכשלה. נסו שוב בעוד רגע." });

    return send(res, 200, { ok: true, filename, pdf_base64: Buffer.from(pdf).toString("base64") });
  } catch (error) {
    if (sendTokenError(res, error)) return;
    console.error("Form submit failed", error?.name || "Error");
    return send(res, 500, { error: "אירעה תקלה בשליחת הטופס. נסו שוב בעוד רגע." });
  }
}
