import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import handler, {
  verifySignature,
  normalizePhone,
  isValidPhone,
  getKeyStructure,
  extractWebhookData,
} from "../api/agent4u/webhook.mjs";

test("verifySignature verifies HMAC-SHA256 correctly", () => {
  const secret = "test-secret-key-123";
  const rawBody = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
  const expectedHex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBase64 = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");

  // Hex signature
  assert.ok(verifySignature(rawBody, expectedHex, secret));
  // sha256= prefix
  assert.ok(verifySignature(rawBody, `sha256=${expectedHex}`, secret));
  // Base64 signature
  assert.ok(verifySignature(rawBody, expectedBase64, secret));

  // Invalid signatures
  assert.equal(verifySignature(rawBody, "invalid-sig", secret), false);
  assert.equal(verifySignature(rawBody, "", secret), false);
  assert.equal(verifySignature(rawBody, expectedHex, ""), false);
  assert.equal(verifySignature(rawBody, expectedHex, "wrong-secret"), false);
  assert.equal(verifySignature(Buffer.from("tampered"), expectedHex, secret), false);
});

test("normalizePhone standardizes Israeli and international phone formats", () => {
  const canonical = "972521234567";
  assert.equal(normalizePhone("052-123-4567"), canonical);
  assert.equal(normalizePhone("0521234567"), canonical);
  assert.equal(normalizePhone("+972 52 123 4567"), canonical);
  assert.equal(normalizePhone("+972521234567"), canonical);
  assert.equal(normalizePhone("972521234567"), canonical);
  assert.equal(normalizePhone("00972521234567"), canonical);
  assert.equal(normalizePhone("whatsapp:+972521234567"), canonical);
  assert.equal(normalizePhone("+9720521234567"), canonical);
  assert.equal(normalizePhone("521234567"), canonical);

  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone(null), "");
});

test("isValidPhone correctly validates normalized numbers", () => {
  assert.ok(isValidPhone("972521234567"));
  assert.ok(isValidPhone("15551234567"));
  assert.equal(isValidPhone("123"), false);
  assert.equal(isValidPhone(""), false);
  assert.equal(isValidPhone("abc"), false);
});

test("getKeyStructure logs structure only, never content or values", () => {
  const payload = {
    sender: "0521234567",
    secret_note: "סודי ביותר",
    count: 42,
    active: true,
    details: {
      location: "תל אביב",
      items: [
        { name: "דלת", price: 500 }
      ]
    }
  };

  const struct = getKeyStructure(payload);
  const json = JSON.stringify(struct);

  // Structural keys should exist
  assert.ok(json.includes('"sender":"string"'));
  assert.ok(json.includes('"secret_note":"string"'));
  assert.ok(json.includes('"count":"number"'));
  assert.ok(json.includes('"active":"boolean"'));
  assert.ok(json.includes('"details"'));

  // No values should leak!
  assert.equal(json.includes("0521234567"), false);
  assert.equal(json.includes("סודי ביותר"), false);
  assert.equal(json.includes("תל אביב"), false);
  assert.equal(json.includes("דלת"), false);
  assert.equal(json.includes("500"), false);
});

test("extractWebhookData extracts sender phone and text defensively from Meta shape", () => {
  const metaTextPayload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: "972521234567",
            type: "text",
            text: { body: "תיקון טיח בסלון" }
          }]
        }
      }]
    }]
  };

  const textRes = extractWebhookData(metaTextPayload);
  assert.equal(textRes.senderPhone, "972521234567");
  assert.equal(textRes.messageText, "תיקון טיח בסלון");
  assert.equal(textRes.isNonText, false);

  const metaAudioPayload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: "972521234567",
            type: "audio",
            audio: { id: "12345" }
          }]
        }
      }]
    }]
  };

  const audioRes = extractWebhookData(metaAudioPayload);
  assert.equal(audioRes.senderPhone, "972521234567");
  assert.equal(audioRes.isNonText, true);
});

test("extractWebhookData extracts sender phone and text from Twilio shape", () => {
  const twilioPayload = {
    From: "whatsapp:+972521234567",
    Body: "התקנת מזגן",
    NumMedia: "0"
  };

  const res = extractWebhookData(twilioPayload);
  assert.equal(res.senderPhone, "whatsapp:+972521234567");
  assert.equal(res.messageText, "התקנת מזגן");
  assert.equal(res.isNonText, false);

  const twilioMedia = {
    From: "whatsapp:+972521234567",
    NumMedia: "1"
  };
  assert.equal(extractWebhookData(twilioMedia).isNonText, true);
});

test("extractWebhookData extracts sender phone and text from flat and nested CRM shapes", () => {
  const flatPayload = {
    phone: "052-1234567",
    text: "פירוק ריצוף קיים"
  };
  const flatRes = extractWebhookData(flatPayload);
  assert.equal(flatRes.senderPhone, "052-1234567");
  assert.equal(flatRes.messageText, "פירוק ריצוף קיים");
  assert.equal(flatRes.isNonText, false);

  const nestedPayload = {
    customer: { mobile: "050-999-8888" },
    message: { content: "עבודות צבע" }
  };
  const nestedRes = extractWebhookData(nestedPayload);
  assert.equal(nestedRes.senderPhone, "050-999-8888");
  assert.equal(nestedRes.messageText, "עבודות צבע");

  const imagePayload = {
    phone: "0521234567",
    type: "image",
    image_url: "https://example.com/photo.jpg"
  };
  assert.equal(extractWebhookData(imagePayload).isNonText, true);
});

function createMockReqRes({ method = "POST", headers = {}, body = "" }) {
  const req = {
    method,
    headers,
    rawBody: Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"),
  };
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, val) {
      this.headers[key.toLowerCase()] = val;
    },
    end(val) {
      this.body = val ? JSON.parse(val) : null;
    },
  };
  return { req, res };
}

test("webhook endpoint rejects invalid signatures with 401", async () => {
  process.env.AGENT4U_SHARED_SECRET = "secret";
  const { req, res } = createMockReqRes({
    headers: { "x-agent4u-signature": "wrong" },
    body: JSON.stringify({ phone: "0521234567", text: "בדיקה" }),
  });

  await handler(req, res);
  assert.equal(res.statusCode, 401);
});

test("webhook endpoint rejects non-POST requests with 405", async () => {
  const { req, res } = createMockReqRes({ method: "GET" });
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test("webhook endpoint enforces demo gate when AGENT4U_DEMO_MODE=true", async () => {
  const secret = "test-secret";
  process.env.AGENT4U_SHARED_SECRET = secret;
  process.env.AGENT4U_DEMO_MODE = "true";
  process.env.AGENT4U_DEMO_PHONE = "052-123-4567";

  // 1. Non-demo phone gets HTTP 200 with empty reply and no AI call
  const bodyNonDemo = JSON.stringify({ phone: "050-987-6543", text: "עבודות צבע" });
  const sigNonDemo = crypto.createHmac("sha256", secret).update(Buffer.from(bodyNonDemo)).digest("hex");
  const { req: req1, res: res1 } = createMockReqRes({
    headers: { "x-agent4u-signature": sigNonDemo },
    body: bodyNonDemo,
  });
  await handler(req1, res1);
  assert.equal(res1.statusCode, 200);
  assert.deepEqual(res1.body, { reply: "" });

  // 2. Demo phone with non-text gets HTTP 200 with text-only message
  const bodyVoice = JSON.stringify({ phone: "+972521234567", type: "audio", audio: "base64" });
  const sigVoice = crypto.createHmac("sha256", secret).update(Buffer.from(bodyVoice)).digest("hex");
  const { req: req2, res: res2 } = createMockReqRes({
    headers: { "x-agent4u-signature": sigVoice },
    body: bodyVoice,
  });
  await handler(req2, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.reply, "כרגע ניתן לשלוח הודעות טקסט בלבד.");

  // 3. If demo mode is on but demo phone is missing/invalid, block everyone
  process.env.AGENT4U_DEMO_PHONE = "";
  const { req: req3, res: res3 } = createMockReqRes({
    headers: { "x-agent4u-signature": sigVoice },
    body: bodyVoice,
  });
  await handler(req3, res3);
  assert.equal(res3.statusCode, 200);
  assert.deepEqual(res3.body, { reply: "" });
});
