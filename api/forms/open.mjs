import { getFormDefinition } from "../../src/forms/definitions.mjs";
import { openFormToken, FormTokenError } from "../../src/forms/token.mjs";
import { cleanFormFields } from "../../src/forms/validate.mjs";
import { send, readJsonBody, sendTokenError } from "../../src/forms/http.mjs";

/** Public: returns the prefilled fields of a personal form link. Protected only by the token. */
export default function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "שיטת הבקשה אינה נתמכת." });
  }
  const body = readJsonBody(req);
  const def = getFormDefinition(body.form);
  if (!def) return send(res, 404, { error: "הטופס לא נמצא." });

  try {
    const token = openFormToken(body.token);
    if (token.formId !== def.id) throw new FormTokenError("invalid");
    return send(res, 200, { form: def.id, fields: cleanFormFields(def, token.fields), expires_at: token.expiresAt });
  } catch (error) {
    if (sendTokenError(res, error)) return;
    console.error("Form open failed", error?.name || "Error");
    return send(res, 500, { error: "אירעה תקלה. נסו שוב בעוד רגע." });
  }
}
