import { getFormDefinition, renderFormBody, isFileField, isFieldVisible, DEFAULT_SECTION } from "../src/forms/definitions.mjs";
import { cleanFormFields, validateFormFields } from "../src/forms/validate.mjs";
import { shareFile } from "../app/pdf.mjs";

const content = document.getElementById("content");
const formId = location.pathname.split("/").filter(Boolean)[1] || "";
const token = new URLSearchParams(location.search).get("t") || "";
const def = getFormDefinition(formId);

const MAX_IMAGE_BYTES = 600 * 1024;
const BLANK = "________";

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

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error("לא ניתן לקרוא את התמונה."));
  reader.readAsDataURL(blob);
});

/** A chosen photo as a JPEG data URL of at most 600 KB: scaled down and recompressed until it fits. */
async function compressImage(file) {
  if (file.type && !/^image\/(jpeg|png)$/.test(file.type)) throw new Error("יש לבחור תמונה בפורמט JPG או PNG.");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => { throw new Error("לא ניתן לקרוא את התמונה. בחרו קובץ JPG או PNG."); });
    let maxSide = 1600, quality = 0.85;
    for (let attempt = 0; attempt < 10; attempt++) {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      canvas.width = canvas.height = 0;
      if (blob && blob.size <= MAX_IMAGE_BYTES) return await blobToDataUrl(blob);
      if (quality > 0.55) quality -= 0.1;
      else maxSide = Math.round(maxSide * 0.75);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
  throw new Error("התמונה גדולה מדי. נסו תמונה אחרת.");
}

function fieldLabel(field, htmlFor) {
  const required = field.required ? el("span", { className: "req", textContent: " *" }) : null;
  return htmlFor ? el("label", { htmlFor }, field.label, required) : el("div", { className: "field-label" }, field.label, required);
}

function textInput(field, id) {
  if (field.type === "textarea") return el("textarea", { id, name: field.key, maxLength: field.maxLength || 200 });
  const input = el("input", { id, name: field.key, type: "text", maxLength: field.maxLength || 200, autocomplete: "off" });
  if (field.type === "israeli_id" || field.type === "company_number") Object.assign(input, { inputMode: "numeric", maxLength: 20 });
  if (field.type === "phone") Object.assign(input, { type: "tel", inputMode: "tel", maxLength: 30, className: "ltr" });
  if (field.type === "email") Object.assign(input, { type: "email", inputMode: "email", autocapitalize: "off", spellcheck: false, className: "ltr" });
  return input;
}

function renderForm(prefill) {
  const controls = {};
  const images = {};
  const pads = {};
  const sectionCards = new Map();
  const signatureCards = [];
  const legal = el("div", { className: "legal" });

  const readValues = () => cleanFormFields(def, Object.fromEntries(def.fields
    .filter(field => !isFileField(field))
    .map(field => [field.key, controls[field.key].read()])));

  const renderLegal = values => {
    const filled = Object.fromEntries(def.fields.map(field => [field.key, field.type === "choice" ? values[field.key] : values[field.key] || BLANK]));
    legal.replaceChildren(...renderFormBody(def, filled).map(line => el("p", {
      className: line.heading ? "heading" : "",
      textContent: line.image ? `${line.text}: ${line.signature ? "בתיבת החתימה למטה" : "בתמונה שהועלתה"}` : line.text,
    })));
  };

  const updateVisibility = values => {
    for (const field of def.fields) controls[field.key].box.hidden = !isFieldVisible(field, values);
    for (const [name, card] of sectionCards) {
      card.hidden = !def.fields.some(field => !controls[field.key].box.hidden && field.type !== "signature" && (field.section || DEFAULT_SECTION) === name);
    }
  };

  const setError = (key, message) => {
    controls[key].error.textContent = message;
    controls[key].wrapper.classList.toggle("invalid", Boolean(message));
  };

  const refresh = () => {
    const values = readValues();
    updateVisibility(values);
    renderLegal(values);
  };

  for (const field of def.fields) {
    const id = `f-${field.key}`;
    const error = el("div", { className: "err" });

    if (field.type === "signature") {
      const title = field.pageLabel || field.label;
      const canvas = el("canvas", { className: "pad", ariaLabel: title });
      const hint = el("div", { className: "pad-hint", textContent: "חתמו כאן באצבע" });
      const wrapper = el("div", {}, el("div", { className: "pad-wrap" }, canvas, hint), error);
      const clear = el("button", { type: "button", className: "link", textContent: "ניקוי חתימה" });
      const card = el("section", { className: "card" }, el("div", { className: "row" }, el("h2", { textContent: title }), clear), wrapper);
      signatureCards.push(card);
      controls[field.key] = { box: card, wrapper, error, focus: canvas, canvas, hint, clear };
      continue;
    }

    let control, read = () => "", focus;
    if (field.type === "choice") {
      control = el("div", { className: "choice", role: "radiogroup", ariaLabel: field.label });
      for (const option of field.options) {
        const radio = el("input", { type: "radio", name: field.key, value: option.value, checked: prefill[field.key] === option.value });
        radio.addEventListener("change", () => { setError(field.key, ""); refresh(); });
        control.append(el("label", { className: "option" }, radio, el("span", { textContent: option.label })));
      }
      read = () => control.querySelector("input:checked")?.value || "";
      focus = control;
    } else if (field.type === "image") {
      const fileInput = el("input", { id, type: "file", accept: "image/jpeg,image/png" });
      const preview = el("img", { className: "preview", alt: field.label, hidden: true });
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        delete images[field.key];
        preview.hidden = true;
        if (!file) return;
        setError(field.key, "");
        try {
          images[field.key] = await compressImage(file);
          preview.src = images[field.key];
          preview.hidden = false;
        } catch (err) {
          fileInput.value = "";
          setError(field.key, err.message);
        }
      });
      control = el("div", {}, fileInput, preview);
      focus = fileInput;
    } else {
      const input = textInput(field, id);
      input.value = prefill[field.key] || "";
      input.addEventListener("input", () => { setError(field.key, ""); refresh(); });
      control = input;
      read = () => input.value;
      focus = input;
    }

    const wrapper = el("div", {}, fieldLabel(field, field.type === "choice" ? null : id), control, error);
    const section = field.section || DEFAULT_SECTION;
    if (!sectionCards.has(section)) sectionCards.set(section, el("section", { className: "card" }, el("h2", { textContent: section })));
    sectionCards.get(section).append(wrapper);
    controls[field.key] = { box: wrapper, wrapper, error, focus, read };
  }

  const legalCard = el("section", { className: "card" }, el("h2", { textContent: "נוסח הטופס" }), legal);
  const submit = el("button", { type: "submit", className: "btn", textContent: "שליחה" });
  const formEl = el("form", { noValidate: true }, el("h1", { textContent: def.title }), ...sectionCards.values(), legalCard, ...signatureCards, submit);
  content.replaceChildren(formEl);

  for (const field of def.fields) {
    if (field.type !== "signature") continue;
    const { canvas, hint, clear } = controls[field.key];
    pads[field.key] = signaturePad(canvas, has => {
      hint.hidden = has;
      if (has) setError(field.key, "");
    });
    clear.addEventListener("click", () => pads[field.key].clear());
  }
  refresh();

  const showErrors = errors => {
    let first = null;
    for (const field of def.fields) {
      const message = errors[field.key] || "";
      setError(field.key, message);
      if (message && !first) first = controls[field.key].focus;
    }
    first?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  formEl.addEventListener("submit", async event => {
    event.preventDefault();
    const fields = readValues();
    const errors = validateFormFields(def, fields);
    const files = {};
    for (const field of def.fields) {
      if (!isFileField(field) || !isFieldVisible(field, fields)) continue;
      if (field.type === "signature") {
        if (pads[field.key].hasInk()) files[field.key] = pads[field.key].toDataURL();
        else if (field.required) errors[field.key] = "חסרה חתימה";
      } else if (images[field.key]) {
        files[field.key] = images[field.key];
      } else if (field.required) {
        errors[field.key] ||= controls[field.key].error.textContent || "יש להעלות תמונה";
      }
    }
    if (Object.keys(errors).length) return showErrors(errors);

    submit.disabled = true;
    submit.textContent = "שולח…";
    try {
      const { ok, data } = await postJson("/api/forms/submit", { form: def.id, token, fields, files });
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
