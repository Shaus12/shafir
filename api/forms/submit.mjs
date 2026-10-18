import { getFormDefinition } from "../../src/forms/definitions.mjs";
import { openFormToken, formsSecretConfigured, FormTokenError } from "../../src/forms/token.mjs";
import { cleanFormFields, validateFormFields } from "../../src/forms/validate.mjs";
import { renderFormPdf, formContentHash, signatureHasInk, israelDateTime } from "../../src/forms/pdf.mjs";
import { sendFile } from "../../src/agent4u-crm.mjs";
import { send, readJsonBody, sendTokenError } from "../../src/forms/http.mjs";

const MAX_SIGNATURE_BYTES = 600 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function signatureBytes(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === "string" ? dataUrl : "");
  if (!match) return null;
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length || bytes.length > MAX_SIGNATURE_BYTES || !PNG_MAGIC.every((byte, i) => bytes[i] === byte)) return null;
  return bytes;
}

const safeFileName = text => text.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Public: sign a form. The token decides the form, the client the PDF goes to and the worker phone;
 * the signer's fields and signature are validated, rendered to a PDF and sent. Nothing is stored.
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

    const values = cleanFormFields(def, body.fields);
    const errors = validateFormFields(def, values);
    if (Object.keys(errors).length) return send(res, 400, { error: "יש לתקן את השדות המסומנים.", fields: errors });

    const signaturePng = signatureBytes(body.signature);
    if (!signaturePng || !(await signatureHasInk(signaturePng))) {
      return send(res, 400, { error: "יש לחתום בתיבת החתימה.", fields: { signature: "חסרה חתימה" } });
    }

    const signedAt = new Date();
    const hash = formContentHash({ def, values, signaturePng, signedAt, workerPhone: token.workerPhone });
    const pdf = await renderFormPdf({ def, values, signaturePng, signedAt, workerPhone: token.workerPhone, hash });

    const filename = `${safeFileName(`${def.title} ${israelDateTime(signedAt).replace(/[/:]/g, "-")}`)}.pdf`;
    const summary = def.summaryField ? values[def.summaryField] : "";
    const caption = summary ? `${def.title} חתום: ${summary}` : `${def.title} חתום`;
    const sent = await sendFile(token.clientId, caption, "form-pdf", pdf, { mime: "application/pdf", filename });
    if (!sent) return send(res, 502, { error: "הטופס נחתם אך השליחה נכשלה. נסו שוב בעוד רגע." });

    return send(res, 200, { ok: true, filename, pdf_base64: Buffer.from(pdf).toString("base64") });
  } catch (error) {
    if (sendTokenError(res, error)) return;
    console.error("Form submit failed", error?.name || "Error");
    return send(res, 500, { error: "אירעה תקלה בשליחת הטופס. נסו שוב בעוד רגע." });
  }
}
