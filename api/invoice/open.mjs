import { send, readJsonBody, sendTokenError } from "../../src/forms/http.mjs";
import { openInvoice } from "../../src/invoice/service.mjs";

/** Public: the invoice preview of a personal approval link. Protected only by the token. */
export default function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "שיטת הבקשה אינה נתמכת." });
  }
  try {
    return send(res, 200, openInvoice(readJsonBody(req).token));
  } catch (error) {
    if (error?.name === "InvoiceError") return send(res, error.status, { error: error.message });
    if (sendTokenError(res, error)) return;
    console.error("Invoice open failed", error?.name || "Error");
    return send(res, 500, { error: "אירעה תקלה. נסו שוב בעוד רגע." });
  }
}
