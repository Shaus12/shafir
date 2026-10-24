import { SUBCHAPTERS, UNIT_OPTIONS } from "./skn/model.mjs";

// Recovers work items from our own formatProposedItemsReply text, and detects SKN requests.

export const SKN_HINT = "לקובץ לבינארית כתבו: שלח SKN";
export const NO_RECENT_ITEMS = "לא מצאתי סעיפים אחרונים. שלחו שוב את תיאור העבודה וכתבו בסוף: לבינארית";

const SKN_WORDS = /בינארית|לבינארית|skn|סקן/i;
const FILLER = new Set(["שלח", "שלחו", "תשלח", "תשלחו", "את", "אותו", "הקובץ", "קובץ", "ה", "ל", "נא", "בבקשה", "גם", "ושלח", "ושלחו"]);

export const wantsSkn = text => SKN_WORDS.test(String(text || ""));

/** True when the message holds nothing but an SKN request. */
export function isSknOnlyRequest(text) {
  const rest = String(text || "")
    .replace(new RegExp(SKN_WORDS.source, "gi"), " ")
    .split(/[\s.,!?:;"'()\-]+/)
    .filter(word => word && !FILLER.has(word));
  return wantsSkn(text) && rest.length === 0;
}

const subchapterByTitle = new Map(SUBCHAPTERS.map(([num, title]) => [title, num]));
const unitLabels = UNIT_OPTIONS.map(([code, label]) => [code, label]);
const NO_QTY = " (כמות לא צוינה)";

function parseItemLine(line, subchapter) {
  const body = line.slice(1).trim();
  const cut = body.lastIndexOf(": ");
  if (cut <= 0) return null;
  const description = body.slice(0, cut).trim();
  const tail = body.slice(cut + 2).trim();
  if (!description) return null;
  for (const [unit, label] of unitLabels) {
    if (tail === `${label}${NO_QTY}`) return { subchapter, unit, quantity: 0, description };
    if (tail.endsWith(` ${label}`)) {
      const quantity = Number(tail.slice(0, -label.length - 1));
      if (Number.isFinite(quantity) && quantity > 0) return { subchapter, unit, quantity, description };
    }
  }
  return null;
}

/** Parse one reply in the formatProposedItemsReply format. Returns [] when it holds no items. */
export function parseItemsReply(text) {
  const items = [];
  let subchapter = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^\*(.+):\*$/);
    if (heading) {
      const title = heading[1];
      subchapter = subchapterByTitle.get(title) ?? Number(title.match(/^תת-פרק (\d+)$/)?.[1]) ?? null;
      if (!Number.isInteger(subchapter)) subchapter = null;
    } else if (line.startsWith("•") && subchapter !== null) {
      const item = parseItemLine(line, subchapter);
      if (item) items.push(item);
    }
  }
  return items;
}

const HISTORY_KEYS = ["history", "conversation_history", "chat_history"];

export function historyFrom(payload) {
  for (const candidate of [...HISTORY_KEYS.map(key => payload?.[key]), payload?.conversation?.history, payload?.conversation?.messages]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/** Payload without history, so history text never leaks into current-message detection. */
export function withoutHistory(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const copy = { ...payload };
  for (const key of HISTORY_KEYS) delete copy[key];
  return copy;
}

const OWN_ROLES = new Set(["assistant", "bot", "agent", "ai", "model", "outbound", "out", "sent"]);

function isOwnMessage(message) {
  if (message?.from_me === true || message?.fromMe === true) return true;
  for (const key of ["role", "direction", "sender", "sender_type", "author"]) {
    const value = message?.[key];
    if (typeof value === "string" && OWN_ROLES.has(value.toLowerCase().trim())) return true;
  }
  return false;
}

function messageText(message) {
  for (const key of ["content", "body", "text", "message"]) {
    const value = message?.[key];
    if (typeof value === "string") return value;
    if (typeof value?.body === "string") return value.body;
    if (typeof value?.text === "string") return value.text;
  }
  return "";
}

/** Items from the bot's most recent items reply in history (newest last), or []. */
export function findLastItems(history) {
  if (!Array.isArray(history)) return [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (!isOwnMessage(history[i])) continue;
    const items = parseItemsReply(messageText(history[i]));
    if (items.length) return items;
  }
  return [];
}

/** The last `count` history messages as { role: "bot" | "user", text } (text cut to 500 chars), oldest first. */
export function recentMessages(history, count) {
  if (!Array.isArray(history)) return [];
  return history
    .map(message => ({ role: isOwnMessage(message) ? "bot" : "user", text: messageText(message).trim().slice(0, 500) }))
    .filter(message => message.text)
    .slice(-count);
}

const QUOTE_HEADER = /^📄\s*\*(.+)\*$/;
const REPLY_TAIL = /^\*?(?:לא שובץ|סעיפים שבדרך כלל מתווספים):\*?$/;

/**
 * Quotes from a reply in the quote-engine format (one "📄 *title*" section per quote: chapter line,
 * "*subchapter:*" line, bullets). Returns specs [{ title, chapterTitle, subTitle, items: [{ unit, quantity, description }] }].
 */
export function parseQuotesReply(text) {
  const specs = [];
  let current = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    const header = QUOTE_HEADER.exec(line);
    if (header) {
      current = { title: header[1] === "הצעת מחיר" ? "" : header[1], chapterTitle: "", subTitle: "", items: [] };
      specs.push(current);
    } else if (REPLY_TAIL.test(line)) {
      current = null;
    } else if (current) {
      const sub = /^\*(.+):\*$/.exec(line);
      const chapter = /^\*(.+)\*$/.exec(line);
      if (sub) current.subTitle = sub[1];
      else if (chapter && !current.chapterTitle) current.chapterTitle = chapter[1];
      else if (line.startsWith("•")) {
        const item = parseItemLine(line, 0);
        if (item) current.items.push({ unit: item.unit, quantity: item.quantity, description: item.description });
      }
    }
  }
  return specs.filter(spec => spec.items.length);
}

/**
 * What the bot's most recent items reply in history holds: { quotes } for the quote-engine format, { items } for
 * the older format (flat items), or null when there is none. Own messages only, newest first.
 */
export function findLastQuotes(history) {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (!isOwnMessage(history[i])) continue;
    const text = messageText(history[i]);
    const quotes = parseQuotesReply(text);
    if (quotes.length) return { quotes };
    const items = parseItemsReply(text);
    if (items.length) return { items };
  }
  return null;
}
