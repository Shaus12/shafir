// Agent4U CRM WhatsApp API: text messages and files (upload, then send by media id).
// Logs carry status codes and error types only.

export const CRM_SEND_URL = "https://crm.agent4u.co.il/api/whatsapp/send";
export const CRM_MEDIA_URL = "https://crm.agent4u.co.il/api/whatsapp/media";

/** POST to the send API. Returns true when the CRM accepted the message. */
export async function postToCrmSend(payload) {
  const requestShape = {
    fields: Object.keys(payload),
    media_base64_length: typeof payload.media_base64 === "string" ? payload.media_base64.length : 0,
  };
  try {
    const response = await fetch(CRM_SEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.AGENT4U_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error("Agent4U send failed", response.status, JSON.stringify(requestShape));
    }
    return response.ok;
  } catch (error) {
    console.error("Agent4U send failed", error?.name || "Error", JSON.stringify(requestShape));
    return false;
  }
}

export function sendToWorker(clientId, body) {
  return postToCrmSend({ client_id: clientId, body });
}

function findMediaId(data) {
  for (const [prefix, source] of [["", data], ["data.", data?.data]]) {
    for (const key of ["media_id", "id"]) {
      const value = source?.[key];
      if ((typeof value === "string" && value.trim()) || typeof value === "number") return { value, field: prefix + key };
    }
  }
  return null;
}

export function mediaIdFrom(data) {
  return findMediaId(data)?.value ?? null;
}

const objectKeys = value => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];

async function uploadMedia(clientId, { media_base64, mime, filename }) {
  let response;
  try {
    response = await fetch(CRM_MEDIA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.AGENT4U_API_KEY}`,
      },
      body: JSON.stringify({ client_id: clientId, base64: media_base64, mime, filename }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error("Agent4U media upload failed", error?.name || "Error");
    return null;
  }
  const text = await response.text().catch(() => "");
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  const found = response.ok ? findMediaId(data) : null;
  if (!found) {
    console.error("Agent4U media upload failed", response.status, text.slice(0, 300), JSON.stringify(objectKeys(data)));
    return null;
  }
  return found.value;
}

export function fileBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function base64MatchesBytes(base64, bytes) {
  return Buffer.from(base64, "base64").equals(Buffer.from(bytes));
}

/** Upload a file and send it as a WhatsApp document. Returns true when both steps succeeded. */
export async function sendFile(clientId, caption, kind, bytes, { mime, filename }) {
  const media_base64 = fileBase64(bytes);
  if (!base64MatchesBytes(media_base64, bytes)) {
    console.error("file encoding mismatch", kind);
    return false;
  }
  const mediaId = await uploadMedia(clientId, { media_base64, mime, filename });
  if (mediaId === null) return false;
  return postToCrmSend({ client_id: clientId, document: { id: mediaId, filename, caption } });
}
