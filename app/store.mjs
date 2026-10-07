// Quote storage. For now quotes live in this device's IndexedDB; the same four functions
// will be backed by Supabase once it is connected, so the UI does not change.

const DB_NAME = "shafir";
const STORE = "quotes";
let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** @returns {Promise<object[]>} newest first */
export async function listQuotes() {
  const all = (await run("readonly", s => s.getAll())) ?? [];
  return all.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export const getQuote = id => run("readonly", s => s.get(id));

export function saveQuote(quote) {
  quote.updatedAt = new Date().toISOString();
  return run("readwrite", s => s.put(structuredClone(quote)));
}

export const deleteQuote = id => run("readwrite", s => s.delete(id));
