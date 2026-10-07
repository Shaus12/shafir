import { sknToQuote, quoteToSkn, quoteTotals, parseAmount, SUBCHAPTERS, UNIT_OPTIONS, newId } from "../src/skn/model.mjs";
import { listQuotes, getQuote, saveQuote, deleteQuote } from "./store.mjs";
import { printQuote, shareFile, itemLabel } from "./pdf.mjs";

const app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const two = n => String(n).padStart(2, "0");
const plain = n => (n ? String(n) : "");

let quote = null;        // the quote open in the editor
let openSubs = new Set(); // "ci-num" keys of expanded subchapters, kept across re-renders
let saveTimer = null;

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
});

function arm(btn, run, label = "בטוח?") {
  if (btn.classList.contains("armed")) return run();
  const was = btn.textContent;
  btn.classList.add("armed");
  btn.textContent = label;
  setTimeout(() => { if (btn.isConnected) { btn.classList.remove("armed"); btn.textContent = was; } }, 3000);
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
