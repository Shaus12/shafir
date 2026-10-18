// Small HTTP helpers shared by the public form endpoints.

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(body));
}

export function readJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  try {
    const text = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

const TOKEN_ERRORS = {
  invalid: [401, "הקישור אינו תקין. בקשו מהעובד קישור חדש."],
  expired: [410, "תוקף הקישור פג. בקשו מהעובד קישור חדש."],
  not_configured: [500, "השירות אינו מוגדר כרגע."],
};

/** Respond to a FormTokenError. Returns false for any other error. */
export function sendTokenError(res, error) {
  const entry = error?.name === "FormTokenError" ? TOKEN_ERRORS[error.code] : null;
  if (!entry) return false;
  send(res, entry[0], { error: entry[1] });
  return true;
}
