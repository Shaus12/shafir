import { extractProposedItems } from "../src/proposed-items.mjs";

const TRANSCRIPTION_MODEL = "gpt-transcribe";
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_LENGTH = 20_000;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function normalizeMimeType(value) {
  const mime = String(value || "").toLowerCase().split(";", 1)[0];
  if (mime === "audio/mp4" || mime === "audio/x-m4a") return "audio/m4a";
  const allowed = new Set(["audio/wav", "audio/mp3", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac", "audio/mpeg", "audio/m4a", "audio/l16", "audio/opus", "audio/alaw", "audio/mulaw", "audio/webm"]);
  return allowed.has(mime) ? mime : "";
}

function audioExtension(mimeType) {
  return ({
    "audio/wav": "wav",
    "audio/mp3": "mp3",
    "audio/mpeg": "mpeg",
    "audio/m4a": "m4a",
    "audio/webm": "webm",
    "audio/aiff": "aiff",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/opus": "opus",
    "audio/l16": "l16",
    "audio/alaw": "alaw",
    "audio/mulaw": "mulaw",
  })[mimeType] || "audio";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "שיטת הבקשה אינה נתמכת." });
  }
  if (!process.env.ACCESS_CODE || req.headers["x-access-code"] !== process.env.ACCESS_CODE) {
    return send(res, 401, { error: "קוד הגישה שגוי." });
  }
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const audio = typeof req.body?.audio === "string" ? req.body.audio : "";
  if (!text && !audio) return send(res, 400, { error: "יש להקליט או להקליד תיאור של העבודה." });
  if (text.length > MAX_TEXT_LENGTH) return send(res, 413, { error: "הטקסט ארוך מדי." });
  if (!process.env.OPENAI_API_KEY) {
    return send(res, 500, { error: "השירות אינו מוגדר כרגע." });
  }

  let transcript = text;
  if (!transcript) {
    const mimeType = normalizeMimeType(req.body?.mimeType);
    if (!mimeType) return send(res, 400, { error: "פורמט ההקלטה אינו נתמך." });
    const approximateBytes = Math.floor(audio.length * 0.75);
    if (approximateBytes > MAX_AUDIO_BYTES) return send(res, 413, { error: "ההקלטה ארוכה מדי. אפשר להקליט עד 5 דקות." });

    try {
      const form = new FormData();
      form.append("file", new Blob([Buffer.from(audio, "base64")], { type: mimeType }), `recording.${audioExtension(mimeType)}`);
      form.append("model", TRANSCRIPTION_MODEL);
      form.append("languages[]", "he");
      form.append("response_format", "json");
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      });
      if (!response.ok) {
        console.error("OpenAI transcription failed", response.status, await response.text());
        return send(res, 502, { error: "לא הצלחנו לתמלל את ההקלטה. נסו להקליט שוב." });
      }
      const data = await response.json();
      transcript = typeof data?.text === "string" ? data.text.trim() : "";
      if (!transcript) return send(res, 502, { error: "לא הצלחנו לתמלל את ההקלטה. נסו להקליט שוב." });
    } catch (error) {
      console.error("OpenAI transcription failed", error);
      return send(res, 502, { error: "לא הצלחנו לתמלל את ההקלטה. נסו להקליט שוב." });
    }
  }

  try {
    const result = await extractProposedItems(transcript);
    return send(res, 200, result);
  } catch (error) {
    if (error.status === 502) {
      return send(res, 502, { error: "לא הצלחנו לעבד את הרשומה כרגע. נסו שוב." });
    }
    console.error("Field record processing failed", error);
    return send(res, 500, { error: "אירעה תקלה בשרת. נסו שוב בעוד רגע." });
  }
}

