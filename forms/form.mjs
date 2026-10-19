import { getFormDefinition, renderFormBody } from "../src/forms/definitions.mjs";
import { cleanFormFields, validateFormFields } from "../src/forms/validate.mjs";
import { shareFile } from "../app/pdf.mjs";

const content = document.getElementById("content");
const formId = location.pathname.split("/").filter(Boolean)[1] || "";
const token = new URLSearchParams(location.search).get("t") || "";
const def = getFormDefinition(formId);

let toastTimer;
function toast(text, err = false) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.className = `toast${err ? " err" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), err ? 5000 : 2600);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function showStatus(text, error = false) {
  content.replaceChildren(el("p", { className: `status${error ? " error" : ""}`, textContent: text }));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    referrerPolicy: "no-referrer",
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

/** Finger / mouse signature box. Clears itself when its width changes (e.g. rotating the phone). */
function signaturePad(canvas, onChange) {
  const ctx = canvas.getContext("2d");
  let drawing = false, last = null, ink = 0, width = 0;

  const setup = () => {
    const rect = canvas.getBoundingClientRect();
    if (Math.round(rect.width) === width) return;
    width = Math.round(rect.width);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111";
    ctx.fillStyle = "#111";
    ink = 0;
    onChange(false);
  };
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  canvas.addEventListener("pointerdown", event => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drawing = true;
    last = point(event);
    ctx.beginPath();
    ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  });
  canvas.addEventListener("pointermove", event => {
    if (!drawing) return;
    event.preventDefault();
    const next = point(event);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    ink += Math.hypot(next.x - last.x, next.y - last.y);
    last = next;
    if (ink > 20) onChange(true);
  });
  const end = () => { drawing = false; last = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  new ResizeObserver(setup).observe(canvas);
  setup();

  return {
    hasInk: () => ink > 20,
    clear: () => { width = 0; setup(); },
    toDataURL: () => canvas.toDataURL("image/png"),
  };
}

function renderForm(values) {
  const inputs = {};
  const errorEls = {};
  const wrappers = {};

  const legal = el("div", { className: "legal" });
  const renderLegal = () => {
    const current = cleanFormFields(def, Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])));
    const filled = Object.fromEntries(def.fields.map(field => [field.key, current[field.key] || "________"]));
    legal.replaceChildren(...renderFormBody(def, filled).map(line =>
      el("p", { textContent: line.signature ? `${line.text}: בתיבת החתימה למטה` : line.text })));
  };

  const fieldsCard = el("section", { className: "card" }, el("h2", { textContent: "פרטי הלקוח" }));
  for (const field of def.fields) {
    const id = `f-${field.key}`;
    const input = field.type === "textarea"
      ? el("textarea", { id, name: field.key, maxLength: field.maxLength || 200 })
      : el("input", { id, name: field.key, type: "text", maxLength: field.maxLength || 200, autocomplete: "off" });
    if (field.type === "israeli_id") Object.assign(input, { type: "text", inputMode: "numeric", maxLength: 20 });
    input.value = values[field.key] || "";
    input.addEventListener("input", () => {
      wrappers[field.key].classList.remove("invalid");
      errorEls[field.key].textContent = "";
      renderLegal();
    });
    const label = el("label", { htmlFor: id }, field.label, field.required ? el("span", { className: "req", textContent: " *" }) : null);
    errorEls[field.key] = el("div", { className: "err" });
    wrappers[field.key] = el("div", {}, label, input, errorEls[field.key]);
    inputs[field.key] = input;
    fieldsCard.append(wrappers[field.key]);
  }

  const legalCard = el("section", { className: "card" }, el("h2", { textContent: "נוסח הטופס" }), legal);

  const canvas = el("canvas", { className: "pad", ariaLabel: "תיבת חתימה" });
  const hint = el("div", { className: "pad-hint", textContent: "חתמו כאן באצבע" });
  const signatureError = el("div", { className: "err" });
  const signatureWrap = el("div", {}, el("div", { className: "pad-wrap" }, canvas, hint), signatureError);
  const clearButton = el("button", { type: "button", className: "link", textContent: "ניקוי חתימה" });
  const signatureCard = el("section", { className: "card" },
    el("div", { className: "row" }, el("h2", { textContent: "חתימת הלקוח" }), clearButton), signatureWrap);

  const submit = el("button", { type: "submit", className: "btn", textContent: "שליחה" });
  const formEl = el("form", { noValidate: true }, el("h1", { textContent: def.title }), fieldsCard, legalCard, signatureCard, submit);
  content.replaceChildren(formEl);

  const pad = signaturePad(canvas, has => {
    hint.hidden = has;
    if (has) { signatureWrap.classList.remove("invalid"); signatureError.textContent = ""; }
  });
  clearButton.addEventListener("click", () => pad.clear());
  renderLegal();

  const showErrors = errors => {
    let first = null;
    for (const field of def.fields) {
      const message = errors[field.key] || "";
      errorEls[field.key].textContent = message;
      wrappers[field.key].classList.toggle("invalid", Boolean(message));
      if (message && !first) first = inputs[field.key];
    }
    if (errors.signature) {
      signatureError.textContent = errors.signature;
      signatureWrap.classList.add("invalid");
      first ||= canvas;
    }
    first?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  formEl.addEventListener("submit", async event => {
    event.preventDefault();
    const fields = cleanFormFields(def, Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])));
    const errors = validateFormFields(def, fields);
    if (!pad.hasInk()) errors.signature = "חסרה חתימה";
    if (Object.keys(errors).length) return showErrors(errors);

    submit.disabled = true;
    submit.textContent = "שולח…";
    try {
      const { ok, data } = await postJson("/api/forms/submit", { form: def.id, token, fields, signature: pad.toDataURL() });
      if (!ok) {
        if (data.fields) showErrors(data.fields);
        throw new Error(data.error || "השליחה נכשלה. נסו שוב.");
      }
      renderDone(data);
    } catch (error) {
      submit.disabled = false;
      submit.textContent = "שליחה";
      toast(error instanceof TypeError ? "אין חיבור לשרת. בדקו את החיבור ונסו שוב." : error.message, true);
    }
  });
}

function renderDone({ filename, pdf_base64: pdfBase64 }) {
  const children = [el("div", { className: "mark", textContent: "✓" }), el("p", { textContent: "הטופס נחתם ונשלח בהצלחה" })];
  if (pdfBase64) {
    const bytes = Uint8Array.from(atob(pdfBase64), ch => ch.charCodeAt(0));
    const blob = new Blob([bytes], { type: "application/pdf" });
    const save = el("button", { type: "button", className: "btn ghost", textContent: "שמירת עותק" });
    save.addEventListener("click", async () => {
      const how = await shareFile(blob, filename || "טופס חתום.pdf", "application/pdf");
      if (how === "downloaded") toast("הקובץ ירד למכשיר");
    });
    children.push(save);
  }
  content.replaceChildren(el("div", { className: "done" }, ...children));
}

async function start() {
  if (!def || !token) return showStatus("הקישור אינו תקין. בקשו מהעובד קישור חדש.", true);
  document.title = `${def.title} · שפיר שיקום נזקים`;
  try {
    const { ok, data } = await postJson("/api/forms/open", { form: def.id, token });
    if (!ok) return showStatus(data.error || "לא ניתן לפתוח את הטופס.", true);
    renderForm(data.fields || {});
  } catch {
    showStatus("אין חיבור לשרת. בדקו את החיבור ונסו שוב.", true);
  }
}

start();
