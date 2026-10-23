// AccountBook API client (https://www.accountbook.co.il/api). HTTPS to cloud.tamal.co.il only.
// Errors carry codes only; credentials, tokens and document data are never logged.

const HOST = "cloud.tamal.co.il";
const BASE = `https://${HOST}`;
const MIN_GAP_MS = 100; // the API answers -2000 to calls less than 80 ms apart

export class AccountBookError extends Error {
  constructor(code, detail = "") {
    super(code);
    this.name = "AccountBookError";
    this.code = code;
    this.detail = detail; // AccountBook's own error answer, shown as is; never holds a token
  }
}

export const accountBookConfigured = (env = process.env) =>
  Boolean(env.ACCOUNTBOOK_USER && env.ACCOUNTBOOK_PASS && /^\d+$/.test(String(env.ACCOUNTBOOK_ESEK_NUM || "").trim()));

/** Real documents only when ACCOUNTBOOK_LIVE is exactly "true" and the credentials are all set. */
export const accountBookLive = (env = process.env) => env.ACCOUNTBOOK_LIVE === "true" && accountBookConfigured(env);

let lastCall = 0;
async function paced() {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastCall = Date.now();
}

export function isTamalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === HOST && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function post(path, fields) {
  await paced();
  let response;
  try {
    response = await fetch(`${BASE}/${path}/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams(fields),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AccountBookError("network");
  }
  if (!response.ok) throw new AccountBookError(`http_${response.status}`);
  return (await response.text()).trim();
}

/** GetToken answers "token,flag1,flag2", or a negative/error text. */
export async function getToken({ user = process.env.ACCOUNTBOOK_USER, pass = process.env.ACCOUNTBOOK_PASS } = {}) {
  const text = await post("GetToken", { userName: user, userPass: pass });
  const parts = text.split(",");
  if (parts.length !== 3 || text.startsWith("-")) throw new AccountBookError("token", parts.length !== 3 ? text.slice(0, 200) : "");
  if (parts[2].trim() === "1") throw new AccountBookError("subscription_expired");
  return parts[0];
}

/** "xxxx,docNum,pdfUrl,htmlUrl" on success, "xxxx,-code,..." on failure. */
export function parseCreateResponse(text) {
  const parts = String(text ?? "").trim().split(",").map(part => part.trim());
  if (parts.length >= 3 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && Number(parts[1]) > 0) {
    return { ok: true, docNumber: parts[1], pdfUrl: parts[2], htmlUrl: parts[3] || "" };
  }
  return { ok: false, codes: parts.filter(part => /^-\d+$/.test(part)) };
}

const NOT_FOUND = new Set(["-13", "2"]);

/** An existing document for the identifier, or null when the log has none. Throws on any other answer. */
export async function findExistingDocument(token, clientIdentifier) {
  const text = await post("GetLoggedResponseByClientIdentifier", { credentialsToken: token, clientIdentifier });
  const parsed = parseCreateResponse(text);
  if (parsed.ok) return parsed;
  if (NOT_FOUND.has(text) || parsed.codes.some(code => NOT_FOUND.has(code))) return null;
  throw new AccountBookError(`lookup_${parsed.codes.join("_") || "unknown"}`);
}

export async function createDocument(token, doc, clientIdentifier) {
  const text = await post("CreateDocument", {
    credentialsToken: token,
    jsonString: JSON.stringify(doc),
    toSign: "1",
    toMail: "0",
    isItemPriceWithTax: "0",
    randomClientMail: "",
    clientIdentifier,
  });
  const parsed = parseCreateResponse(text);
  if (!parsed.ok) throw new AccountBookError(`create_${parsed.codes.join("_") || "unknown"}`);
  return parsed;
}

/** GetUserCompaniesList: [{ key, value }] for the user's companies. Read-only. */
export async function listCompanies(token) {
  const text = await post("GetUserCompaniesList", { credentialsToken: token });
  if (/^-\d+(\s*,\s*-\d+)*$/.test(text)) throw new AccountBookError("companies", text);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AccountBookError("companies_format", text.slice(0, 500));
  }
  const rows = Array.isArray(data) ? data : Array.isArray(data?.d) ? data.d : [data];
  const items = rows.filter(row => row && typeof row === "object" && ("Key" in row || "key" in row))
    .map(row => ({ key: String(row.Key ?? row.key), value: String(row.Value ?? row.value ?? "") }));
  if (!items.length) throw new AccountBookError("companies_format", text.slice(0, 500));
  return items;
}

export async function downloadPdf(url) {
  if (!isTamalUrl(url)) return null;
  try {
    await paced();
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > 0 && bytes.length <= 10 * 1024 * 1024 && bytes.subarray(0, 4).toString() === "%PDF" ? bytes : null;
  } catch {
    return null;
  }
}
