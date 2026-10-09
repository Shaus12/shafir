import { sknToQuote, quoteToSkn, quoteTotals, parseAmount, SUBCHAPTERS, UNIT_OPTIONS, newId } from "../src/skn/model.mjs";
import { listQuotes, getQuote, saveQuote, deleteQuote } from "./store.mjs";
import { printQuote, shareFile, itemLabel } from "./pdf.mjs";
import { quoteToXlsx, XLSX_MIME } from "./xlsx.mjs";

const app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const two = n => String(n).padStart(2, "0");
const plain = n => (n ? String(n) : "");

let quote = null;        // the quote open in the editor
let openSubs = new Set(); // "ci-num" keys of expanded subchapters, kept across re-renders
let saveTimer = null;
const ACCESS_CODE_KEY = "shafir-field-access-code";
const MAX_RECORDING_MS = 5 * 60 * 1000;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;

/* ---------- toast ---------- */
let toastTimer = null;
function toast(text, err = false) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.className = "toast" + (err ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 5000 : 2600);
}

/* ---------- routing ---------- */
async function route() {
  clearTimeout(saveTimer);
  if (quote) await flush();
  const m = location.hash.match(/^#q\/(.+)$/);
  if (m) {
    quote = await getQuote(decodeURIComponent(m[1]));
    if (!quote) { location.hash = ""; return; }
    openSubs = new Set();
    quote.chapters.forEach((ch, ci) => ch.subchapters.forEach((sub, si) => {
      if (quote.source === "manual" || ch.subchapters.length <= 3 || (ci === 0 && si === 0)) openSubs.add(`${ci}-${sub.num}`);
    }));
    renderEditor();
  } else {
    quote = null;
    renderList();
  }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}
async function flush() {
  clearTimeout(saveTimer);
  if (!quote) return;
  try { await saveQuote(quote); } catch { toast("השמירה בטלפון נכשלה. נסו שוב.", true); }
}
window.addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

/* ---------- list ---------- */
async function renderList() {
  const quotes = await listQuotes();
  app.innerHTML = `
    <header class="bar"><h1>הצעות מחיר</h1></header>
    <div class="actions">
      <button class="btn" id="import">ייבוא SKN ממהנדס</button>
      <button class="btn ghost" id="new">הצעה חדשה</button>
    </div>
    ${quotes.length ? quotes.map(q => {
      const t = quoteTotals(q);
      return `<a class="qcard" href="#q/${encodeURIComponent(q.id)}">
        <div class="t">${esc(q.title || "הצעה ללא שם")}</div>
        <div class="m">${q.projectNo ? `<span>תיק <span class="num">${q.projectNo}</span></span>` : ""}
          <span>${t.count} סעיפים</span>
          <span class="tot"><span class="num">${money(t.total)}</span> ₪</span>
          ${t.count ? (t.unpriced ? `<span class="chip warn">${t.unpriced} בלי מחיר</span>` : `<span class="chip ok">מתומחר</span>`) : ""}
          <span>${new Date(q.updatedAt).toLocaleDateString("he-IL")}</span></div></a>`;
    }).join("") : `<div class="empty"><strong>עוד אין הצעות</strong>ייבאו קובץ SKN שהמהנדס שלח, או פתחו הצעה חדשה ובנו אותה מהשטח.</div>`}`;
  document.getElementById("import").onclick = () => document.getElementById("skn-input").click();
  document.getElementById("new").onclick = createQuote;
}

document.getElementById("skn-input").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const q = sknToQuote(new Uint8Array(await file.arrayBuffer()));
    Object.assign(q, { id: newId(), source: "skn", fileName: file.name, createdAt: new Date().toISOString() });
    await saveQuote(q);
    location.hash = "#q/" + encodeURIComponent(q.id);
  } catch (err) {
    toast(`לא הצלחתי לקרוא את ${file.name}. ודאו שזה קובץ SKN. (${err.message})`, true);
  }
});

async function createQuote() {
  const q = { id: newId(), source: "manual", title: "", projectNo: 0, buildingTitle: "", createdAt: new Date().toISOString(),
    chapters: [{ num: 1, title: "אומדן עלות שיקום", subchapters: [] }] };
  await saveQuote(q);
  location.hash = "#q/" + encodeURIComponent(q.id);
}

/* ---------- editor ---------- */
function itemHtml(ch, sub, it, ii) {
  return `<div class="item${it.price ? "" : " unpriced"}" data-id="${it.id}">
    <div class="top"><span class="num">${itemLabel(ch, sub, it, ii)}</span><button class="x" data-del="${it.id}">מחיקה</button></div>
    <textarea data-f="description" rows="2" placeholder="תאור העבודה" aria-label="תאור">${esc(it.description)}</textarea>
    <div class="nums">
      <label>כמות<input data-f="qty" inputmode="decimal" value="${plain(it.qty)}" placeholder="0"></label>
      <label>יחידה<select data-f="unit">${UNIT_OPTIONS.map(([c, l]) => `<option value="${c}"${c === it.unit ? " selected" : ""}>${l}</option>`).join("")}${UNIT_OPTIONS.some(([c]) => c === it.unit) ? "" : `<option selected value="${esc(it.unit)}">${esc(it.unit)}</option>`}</select></label>
      <label>מחיר ליחידה<input data-f="price" inputmode="decimal" value="${plain(it.price)}" placeholder="ללא מחיר"></label>
    </div>
    <div class="line"><span>סה"כ לסעיף</span><b class="num" data-line>${money(it.qty * it.price)}</b></div>
  </div>`;
}

function renderEditor() {
  const t = quoteTotals(quote);
  app.innerHTML = `
    <header class="bar"><a class="back" href="#">→ הצעות</a><h1>${esc(quote.title || "הצעה חדשה")}</h1></header>
    <div class="meta">
      <label>לקוח / כתובת<input id="m-title" value="${esc(quote.title)}" placeholder="שם הלקוח - רחוב ועיר"></label>
      <label>מספר תיק<input id="m-proj" inputmode="numeric" value="${plain(quote.projectNo)}"></label>
    </div>
    <button class="btn ghost wide field-record" id="field-record">● תיעוד מהשטח</button>
    ${quote.chapters.map((ch, ci) => `<section class="chapter" data-ci="${ci}">
      <h2><span class="num">${two(ch.num)}</span><input data-chtitle="${ci}" value="${esc(ch.title)}" aria-label="שם הפרק"></h2>
      ${ch.subchapters.map((sub, si) => `<details class="sub" data-ci="${ci}" data-si="${si}" data-key="${ci}-${sub.num}"${openSubs.has(`${ci}-${sub.num}`) ? " open" : ""}>
        <summary><span class="st">${two(sub.num)} · ${esc(sub.title)}</span><span class="sum num" data-subtotal="${ci}-${si}">${money(t.chapters[ci].subchapters[si])}</span></summary>
        <div class="items">${sub.items.map((it, ii) => itemHtml(ch, sub, it, ii)).join("")}</div>
        <button class="additem" data-add="${ci}-${si}">+ הוספת סעיף</button>
      </details>`).join("")}
      <div class="addsub"><select data-subsel="${ci}" aria-label="תת פרק להוספה"><option value="">הוספת תת פרק…</option>${SUBCHAPTERS.filter(([n]) => !ch.subchapters.some(s => s.num === n)).map(([n, l]) => `<option value="${n}">${two(n)} · ${l}</option>`).join("")}</select></div>
    </section>`).join("")}
    <div class="danger-zone"><button class="x" id="del-quote">מחיקת ההצעה</button></div>
    <div class="total-bar"><div class="in">
      <div class="tt"><small id="t-note"></small><b class="num" id="t-total"></b></div>
      <button class="btn" id="export">ייצוא ושליחה</button>
    </div></div>`;
  updateTotals();
}

function findItem(id) {
  for (const [ci, ch] of quote.chapters.entries())
    for (const [si, sub] of ch.subchapters.entries()) {
      const ii = sub.items.findIndex(it => it.id === id);
      if (ii >= 0) return { ci, si, ii, item: sub.items[ii], sub };
    }
  return null;
}

function updateTotals() {
  const t = quoteTotals(quote);
  document.getElementById("t-total").textContent = money(t.total) + " ₪";
  document.getElementById("t-note").textContent = t.count ? (t.unpriced ? `סה"כ · ${t.unpriced} מתוך ${t.count} סעיפים בלי מחיר` : `סה"כ · ${t.count} סעיפים, הכל מתומחר`) : "עוד אין סעיפים";
  t.chapters.forEach((c, ci) => c.subchapters.forEach((v, si) => {
    const el = document.querySelector(`[data-subtotal="${ci}-${si}"]`);
    if (el) el.textContent = money(v);
  }));
}

app.addEventListener("toggle", e => {
  const d = e.target;
  if (!d.matches?.("details.sub")) return;
  if (d.open) openSubs.add(d.dataset.key); else openSubs.delete(d.dataset.key);
}, true);

app.addEventListener("input", e => {
  if (!quote) return;
  const el = e.target;
  if (el.id === "m-title") { quote.title = el.value; document.querySelector(".bar h1").textContent = el.value || "הצעה חדשה"; return scheduleSave(); }
  if (el.id === "m-proj") {
    const n = Number(el.value.replace(/\D/g, ""));
    el.classList.toggle("bad", el.value !== "" && !Number.isInteger(n));
    quote.projectNo = Number.isInteger(n) ? n : 0;
    return scheduleSave();
  }
  if (el.dataset.chtitle) { quote.chapters[+el.dataset.chtitle].title = el.value; return scheduleSave(); }
  const card = el.closest(".item");
  if (!card) return;
  const found = findItem(card.dataset.id);
  if (!found) return;
  const f = el.dataset.f;
  if (f === "description") found.item.description = el.value;
  else if (f === "qty" || f === "price") {
    try {
      found.item[f] = el.value.trim() === "" ? 0 : parseAmount(el.value, f);
      el.classList.remove("bad");
    } catch { el.classList.add("bad"); return; }
    card.querySelector("[data-line]").textContent = money(found.item.qty * found.item.price);
    card.classList.toggle("unpriced", !found.item.price);
    updateTotals();
  }
  scheduleSave();
});

app.addEventListener("change", e => {
  if (!quote) return;
  const el = e.target;
  if (el.dataset.f === "unit") {
    const found = findItem(el.closest(".item").dataset.id);
    if (found) { found.item.unit = el.value; scheduleSave(); }
  }
  if (el.dataset.subsel !== undefined && el.value) {
    const ch = quote.chapters[+el.dataset.subsel];
    const num = Number(el.value);
    ch.subchapters.push({ num, title: SUBCHAPTERS.find(([n]) => n === num)[1], items: [{ id: newId(), unit: "03", qty: 0, price: 0, description: "" }] });
    ch.subchapters.sort((a, b) => a.num - b.num);
    openSubs.add(`${quote.chapters.indexOf(ch)}-${num}`);
    scheduleSave();
    renderEditor();
    focusLastIn(`[data-ci="${quote.chapters.indexOf(ch)}"][data-si="${ch.subchapters.findIndex(s => s.num === num)}"]`);
  }
});

function focusLastIn(sel) {
  const box = document.querySelector(sel);
  const ta = box?.querySelectorAll(".item textarea");
  const last = ta?.[ta.length - 1];
  if (last) { last.focus(); last.scrollIntoView({ block: "center" }); }
}

app.addEventListener("click", async e => {
  if (!quote) return;
  const add = e.target.closest("[data-add]");
  if (add) {
    const [ci, si] = add.dataset.add.split("-").map(Number);
    const sub = quote.chapters[ci].subchapters[si];
    const prev = sub.items[sub.items.length - 1];
    sub.items.push({ id: newId(), unit: prev?.unit ?? "03", qty: 0, price: 0, description: "" });
    openSubs.add(`${ci}-${sub.num}`);
    scheduleSave();
    renderEditor();
    return focusLastIn(`[data-ci="${ci}"][data-si="${si}"]`);
  }
  const del = e.target.closest("[data-del]");
  if (del) return arm(del, () => {
    const found = findItem(del.dataset.del);
    if (!found) return;
    found.sub.items.splice(found.ii, 1);
    if (!found.sub.items.length) quote.chapters[found.ci].subchapters.splice(found.si, 1);
    scheduleSave();
    renderEditor();
  });
  if (e.target.id === "del-quote") return arm(e.target, async () => {
    const id = quote.id;
    quote = null;
    await deleteQuote(id);
    location.hash = "";
  }, "למחוק לצמיתות?");
  if (e.target.id === "export") openExportSheet();
  if (e.target.id === "field-record") openFieldRecord();
});

function arm(btn, run, label = "בטוח?") {
  if (btn.classList.contains("armed")) return run();
  const was = btn.textContent;
  btn.classList.add("armed");
  btn.textContent = label;
  setTimeout(() => { if (btn.isConnected) { btn.classList.remove("armed"); btn.textContent = was; } }, 3000);
}

/* ---------- field record ---------- */
function preferredAudioType() {
  const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return types.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("לא הצלחנו לקרוא את ההקלטה."));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.readAsDataURL(blob);
  });
}

function openFieldRecord() {
  const bg = document.createElement("div");
  let accessCode = localStorage.getItem(ACCESS_CODE_KEY) || "";
  let mode = "audio";
  let recorder = null;
  let stream = null;
  let chunks = [];
  let audioBlob = null;
  let startedAt = 0;
  let timer = null;

  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet record-sheet" role="dialog" aria-modal="true" aria-label="תיעוד מהשטח">
    <div class="sheet-head"><h3>תיעוד מהשטח</h3><button class="x" data-r="close" aria-label="סגירה">סגירה</button></div>
    <p>הקליטו בעברית את הנזק והעבודה הנדרשת, עד 5 דקות, או הקלידו תיאור.</p>
    <div class="record-tabs"><button class="btn" data-mode="audio">הקלטה</button><button class="btn ghost" data-mode="text">הקלדה</button></div>
    <div data-pane="audio">
      <button class="record-button" data-r="record"><span>●</span><b>התחלת הקלטה</b></button>
      <div class="record-status" data-status>מוכנים להקלטה</div>
    </div>
    <label data-pane="text" hidden>תיאור הנזק והעבודה<textarea rows="7" data-text placeholder="לדוגמה: יש לפרק 12 מ״ר טיח רופף ולבצע טיח חדש..."></textarea></label>
    ${accessCode ? "" : `<label data-code-label>קוד גישה<input data-code type="password" autocomplete="current-password" inputmode="text"></label>`}
    <button class="btn wide" data-r="send" disabled>המשך לבדיקה</button>
  </div>`;
  document.body.appendChild(bg);

  const status = bg.querySelector("[data-status]");
  const send = bg.querySelector('[data-r="send"]');
  const record = bg.querySelector('[data-r="record"]');
  const textArea = bg.querySelector("[data-text]");
  const setReady = () => { send.disabled = mode === "audio" ? !audioBlob : !textArea.value.trim(); };
  const formatTime = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

  function stopTracks() {
    clearInterval(timer);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
  }
  function close() {
    if (recorder?.state === "recording") recorder.stop();
    stopTracks();
    bg.remove();
  }
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return toast("הקלטה אינה נתמכת בדפדפן הזה. אפשר להקליד את התיאור במקום.", true);
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const mimeType = preferredAudioType();
      try {
        recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 24000 });
      } catch {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      }
      chunks = [];
      audioBlob = null;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { stopTracks(); toast("ההקלטה נכשלה. נסו שוב.", true); };
      recorder.onstop = () => {
        stopTracks();
        audioBlob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/webm" });
        record.classList.remove("recording");
        record.querySelector("b").textContent = "הקלטה מחדש";
        status.textContent = `ההקלטה מוכנה · ${formatTime(Math.min(Date.now() - startedAt, MAX_RECORDING_MS))}`;
        if (audioBlob.size > MAX_AUDIO_BYTES) {
          audioBlob = null;
          status.textContent = "ההקלטה ארוכה מדי";
          toast("ההקלטה ארוכה מדי. אפשר להקליט עד 5 דקות.", true);
        }
        setReady();
      };
      recorder.start(1000);
      startedAt = Date.now();
      record.classList.add("recording");
      record.querySelector("b").textContent = "עצירת הקלטה";
      status.textContent = "מקליט · 0:00 מתוך 5:00";
      timer = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        status.textContent = `מקליט · ${formatTime(Math.min(elapsed, MAX_RECORDING_MS))} מתוך 5:00`;
        if (elapsed >= MAX_RECORDING_MS && recorder.state === "recording") {
          recorder.stop();
          toast("ההקלטה נעצרה אחרי 5 דקות — זהו האורך המרבי.", true);
        }
      }, 500);
    } catch (error) {
      stopTracks();
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
        toast("לא ניתנה הרשאה למיקרופון. יש לאפשר גישה למיקרופון בהגדרות הדפדפן.", true);
      } else {
        toast("לא ניתן להפעיל את המיקרופון. אפשר להקליד את התיאור במקום.", true);
      }
    }
  }

  bg.addEventListener("input", setReady);
  bg.addEventListener("click", async event => {
    const modeButton = event.target.closest("[data-mode]");
    if (modeButton) {
      mode = modeButton.dataset.mode;
      if (recorder?.state === "recording") recorder.stop();
      bg.querySelectorAll("[data-mode]").forEach(button => button.classList.toggle("ghost", button !== modeButton));
      bg.querySelectorAll("[data-pane]").forEach(pane => (pane.hidden = pane.dataset.pane !== mode));
      setReady();
      return;
    }
    const action = event.target.closest("[data-r]")?.dataset.r;
    if (event.target === bg || action === "close") return close();
    if (action === "record") {
      if (recorder?.state === "recording") recorder.stop(); else await startRecording();
      return;
    }
    if (action !== "send") return;
    const code = accessCode || bg.querySelector("[data-code]")?.value.trim();
    if (!code) return toast("יש להזין קוד גישה.", true);
    send.disabled = true;
    send.textContent = "מעבד את הרשומה…";
    try {
      const payload = mode === "text"
        ? { text: textArea.value.trim() }
        : { audio: await blobToBase64(audioBlob), mimeType: audioBlob.type };
      const response = await fetch("/api/field-record", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Access-Code": code },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem(ACCESS_CODE_KEY);
          accessCode = "";
          if (!bg.querySelector("[data-code]")) {
            send.insertAdjacentHTML("beforebegin", `<label data-code-label>קוד גישה<input data-code type="password" autocomplete="current-password" inputmode="text"></label>`);
          }
        }
        throw new Error(result.error || (response.status === 401 ? "קוד הגישה שגוי." : "אירעה תקלה בשרת. נסו שוב."));
      }
      localStorage.setItem(ACCESS_CODE_KEY, code);
      close();
      openFieldReview(result);
    } catch (error) {
      send.disabled = false;
      send.textContent = "המשך לבדיקה";
      const message = error instanceof TypeError ? "אירעה תקלה בחיבור לשרת. בדקו את החיבור ונסו שוב." : error.message;
      toast(message || "אירעה תקלה בשרת. נסו שוב.", true);
      if (!accessCode && bg.isConnected) bg.querySelector("[data-code]")?.focus();
    }
  });
}

function openFieldReview(result) {
  let items = Array.isArray(result.items) ? result.items : [];
  const bg = document.createElement("div");
  bg.className = "review-bg";

  function render() {
    const groups = SUBCHAPTERS.flatMap(([num, title]) => {
      const group = items.filter(item => item.subchapter === num);
      if (!group.length) return [];
      return [`<section class="review-group"><h3><span class="num">${two(num)}</span> · ${esc(title)}</h3>${group.map(item => {
        const index = items.indexOf(item);
        const unit = UNIT_OPTIONS.find(([code]) => code === item.unit)?.[1] || item.unit;
        return `<div class="review-item"><div><strong>${esc(item.description)}</strong><span>${item.quantity ? `<span class="num">${esc(item.quantity)}</span> ${esc(unit)}` : `<mark>כמות לא צוינה · 0</mark>`}</span></div><button class="x" data-remove="${index}">הסרה</button></div>`;
      }).join("")}</section>`];
    }).join("");
    bg.innerHTML = `<div class="review" role="dialog" aria-modal="true" aria-label="בדיקת תיעוד מהשטח">
      <header class="bar"><button class="back" data-review="back">→ חזרה</button><h1>בדיקה לפני הוספה</h1></header>
      <section class="transcript"><h2>תמלול</h2><p>${esc(result.transcript || "לא התקבל תמלול.")}</p></section>
      <section class="proposals"><h2>סעיפים מוצעים</h2>${groups || `<div class="empty"><strong>לא נמצאו עבודות להוספה</strong>אפשר לחזור ולהקליט או להקליד תיאור אחר.</div>`}</section>
      <div class="review-actions"><button class="btn ghost" data-review="back">ביטול</button><button class="btn" data-review="confirm"${items.length ? "" : " disabled"}>הוספת ${items.length} סעיפים להצעה</button></div>
    </div>`;
  }
  render();
  document.body.appendChild(bg);
  bg.addEventListener("click", event => {
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      items.splice(Number(remove.dataset.remove), 1);
      return render();
    }
    const action = event.target.closest("[data-review]")?.dataset.review;
    if (action === "back") return bg.remove();
    if (action !== "confirm" || !items.length) return;
    const chapter = quote.chapters[0];
    for (const proposed of items) {
      let sub = chapter.subchapters.find(candidate => candidate.num === proposed.subchapter);
      if (!sub) {
        sub = { num: proposed.subchapter, title: SUBCHAPTERS.find(([num]) => num === proposed.subchapter)[1], items: [] };
        chapter.subchapters.push(sub);
      }
      sub.items.push({ id: newId(), unit: proposed.unit, qty: proposed.quantity, price: 0, description: proposed.description });
      openSubs.add(`0-${sub.num}`);
    }
    chapter.subchapters.sort((a, b) => a.num - b.num);
    scheduleSave();
    bg.remove();
    renderEditor();
    toast(`${items.length} סעיפים נוספו להצעה עם מחיר 0`);
  });
}

/* ---------- export ---------- */
const fileBase = () => (quote.title || "הצעת מחיר").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60);

function openExportSheet() {
  const t = quoteTotals(quote);
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet" role="dialog" aria-label="ייצוא">
    <h3>ייצוא ושליחה</h3>
    ${t.unpriced ? `<p>${t.unpriced} סעיפים עדיין בלי מחיר. הם יופיעו ב-PDF עם 0.</p>` : ""}
    <p>ה-PDF נפתח במסך ההדפסה של הטלפון. משם שומרים כ-PDF או משתפים לוואטסאפ.</p>
    <button class="btn wide" data-x="pdf">PDF עם מחירים</button>
    <button class="btn ghost wide" data-x="pdf-noprice">PDF בלי מחירים (כתב כמויות)</button>
    <button class="btn ghost wide" data-x="xlsx">Excel עם מחירים</button>
    <button class="btn ghost wide" data-x="xlsx-noprice">Excel בלי מחירים</button>
    <button class="btn ghost wide" data-x="skn">קובץ SKN לבינארית</button>
    <button class="btn ghost wide" data-x="close">סגירה</button></div>`;
  document.body.appendChild(bg);
  bg.addEventListener("click", async e => {
    const x = e.target.closest("[data-x]")?.dataset.x;
    if (e.target === bg || x === "close") return bg.remove();
    if (!x) return;
    await flush();
    const btn = e.target.closest("button");
    const label = btn.textContent;
    bg.querySelectorAll("button").forEach(b => (b.disabled = true));
    btn.textContent = "מכין…";
    try {
      if (x === "skn") {
        const bytes = quoteToSkn(quote);
        await done(await shareFile(new Blob([bytes], { type: "application/octet-stream" }), `${quote.projectNo || fileBase()}.skn`, "application/octet-stream"));
      } else if (x === "xlsx" || x === "xlsx-noprice") {
        const prices = x === "xlsx";
        const suffix = prices ? "" : " - כתב כמויות";
        await done(await shareFile(quoteToXlsx(quote, { prices }), `${fileBase()}${suffix}.xlsx`, XLSX_MIME));
      } else {
        bg.remove();
        await printQuote(quote, { prices: x === "pdf" });
        return;
      }
      bg.remove();
    } catch (err) {
      toast(err.message || "הייצוא נכשל", true);
      btn.textContent = label;
      bg.querySelectorAll("button").forEach(b => (b.disabled = false));
    }
  });
}

function done(how) {
  if (how === "downloaded") toast("הקובץ ירד למכשיר");
  else if (how === "shared") toast("נשלח");
}

route();
