import { send, readJsonBody, sendTokenError } from "../../src/forms/http.mjs";
import { approveInvoice } from "../../src/invoice/service.mjs";

/** Public: creates the invoice when the token and the approval code are right. */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "שיטת הבקשה אינה נתמכת." });
  }
  const body = readJsonBody(req);
  try {
    const result = await approveInvoice(body.token, body.code);
    return send(res, 200, result.dryRun
      ? { dry_run: true, title: "מצב בדיקה – לא הופקה חשבונית", document_json: result.json }
      : { dry_run: false, outcome: result.outcome, message: result.message, doc_number: result.docNumber, codes: result.codes });
  } catch (error) {
    if (error?.name === "InvoiceError") return send(res, error.status, { error: error.message });
    if (sendTokenError(res, error)) return;
    console.error("Invoice approval failed", error?.name || "Error");
    return send(res, 500, { error: "אירעה תקלה. נסו שוב בעוד רגע." });
  }
}
