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
