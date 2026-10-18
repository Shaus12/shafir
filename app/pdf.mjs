// Getting the quote out as a PDF: the server renders a real PDF file (api/pdf.mjs), and the
// phone's own print engine is the fallback when the server cannot be reached.

import { quoteDocumentHtml, quoteFileBase } from "../src/quote-document.mjs";

export class PdfAuthError extends Error {}

/**
 * Ask the server for the PDF. Resolves to a File ready for the share sheet.
 * Rejects with PdfAuthError on a wrong access code, and with a plain Error (Hebrew message) otherwise.
 */
export async function requestPdf(q, { prices, accessCode, timeoutMs = 45000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch("/api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-access-code": accessCode },
      body: JSON.stringify({ quote: q, prices }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "השרת לא ענה בזמן." : "אין חיבור לשרת.");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new PdfAuthError("קוד הגישה שגוי.");
  if (!res.ok || !(res.headers.get("content-type") || "").includes("application/pdf")) {
    let message = "יצירת ה-PDF נכשלה.";
    try { message = (await res.json()).error || message; } catch {}
    throw new Error(message);
  }
  return new File([await res.blob()], quoteFileBase(q, { prices }) + ".pdf", { type: "application/pdf" });
}

/**
 * Fallback: print with the phone's own engine (save as PDF / share from the print screen).
 * Not available in apps opened from the Android home screen or inside WhatsApp's browser.
 */
export async function printQuote(q, { prices }) {
  const root = document.getElementById("print-root");
  await document.fonts.ready;
  const el = document.createElement("div");
  el.className = "pdfdoc";
  el.innerHTML = quoteDocumentHtml(q, { prices });
  root.replaceChildren(el);
  const title = document.title;
  document.title = quoteFileBase(q, { prices });
  const restore = () => { document.title = title; root.replaceChildren(); window.removeEventListener("afterprint", restore); };
  window.addEventListener("afterprint", restore);
  window.print();
}

/** Hand a file to the phone's share sheet (WhatsApp, mail…), or download it where sharing files is not supported. */
export async function shareFile(blob, filename, type) {
  const file = blob instanceof File && blob.name === filename ? blob : new File([blob], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return "downloaded";
}
