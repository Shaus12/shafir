// Signed form PDF, rendered on the server with the same approach as the app: pages drawn on a canvas
// (which orders Hebrew correctly) and embedded as JPEGs in a minimal PDF.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { jpegPagesToPdf, wrapText } from "../pdf-writer.mjs";
import { renderFormBody } from "./definitions.mjs";

const PAGE_W = 794;
const PAGE_H = 1123;
const MARGIN = 48;
const SCALE = 2;
const FAMILY = "IBM Plex Sans Hebrew";
const COLORS = { text: "#1c2220", muted: "#4a5451", line: "#c9cfcc" };
const font = (size, weight = 400) => `${weight} ${size}px "${FAMILY}"`;

let assetsPromise = null;

function loadAssets() {
  assetsPromise ??= (async () => {
    for (const file of ["IBMPlexSansHebrew-Regular.ttf", "IBMPlexSansHebrew-Bold.ttf"]) {
      GlobalFonts.registerFromPath(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)), FAMILY);
    }
    const logo = await loadImage(readFileSync(new URL("../../shafir-logo.png", import.meta.url)));
    return { logo };
  })();
  return assetsPromise;
}

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");

/** Israel date and time as DD/MM/YYYY HH:mm. */
export function israelDateTime(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/**
 * SHA-256 of the signed content: form id and title, field values, the legal text as filled in,
 * the signature image, the signing time and the worker phone that created the link.
 */
export function formContentHash({ def, values, signaturePng, signedAt, workerPhone }) {
  return sha256(JSON.stringify({
    form: def.id,
    title: def.title,
    fields: def.fields.map(field => [field.key, values[field.key] ?? ""]),
    text: renderFormBody(def, values).map(line => line.text),
    signature_sha256: sha256(signaturePng),
    signed_at: signedAt.toISOString(),
    created_by: workerPhone || "",
  }));
}

/** True when the signature PNG has enough dark, visible pixels to be a real signature. */
export async function signatureHasInk(pngBytes) {
  let image;
  try {
    image = await loadImage(pngBytes);
  } catch {
    return false;
  }
  if (!image.width || !image.height) return false;
  const width = 200;
  const height = Math.max(1, Math.round((width * image.height) / image.width));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 64 && (data[i] + data[i + 1] + data[i + 2]) / 3 < 160) ink++;
  }
  return ink >= 40;
}

/** Render the signed form. Returns the PDF bytes. */
export async function renderFormPdf({ def, values, signaturePng, signedAt, workerPhone, hash }) {
  const { logo } = await loadAssets();
  const signature = await loadImage(signaturePng);
  const canvas = createCanvas(PAGE_W * SCALE, PAGE_H * SCALE);
  const ctx = canvas.getContext("2d");

  const L = MARGIN, R = PAGE_W - MARGIN, W = R - L, top = MARGIN, bottom = PAGE_H - MARGIN;
  const pages = [];
  let ops, y;
  const newPage = () => { ops = []; pages.push(ops); y = top; };
  const fits = h => y + h <= bottom;
  const text = (str, x, yy, { size = 15, weight = 400, color = COLORS.text, align = "right", dir = "rtl" } = {}) =>
    ops.push(c => { c.font = font(size, weight); c.fillStyle = color; c.direction = dir; c.textAlign = align; c.textBaseline = "top"; c.fillText(str, x, yy); });
  const image = (img, x, yy, w, h) => ops.push(c => c.drawImage(img, x, yy, w, h));
  const rule = (x1, x2, yy, color = COLORS.line, width = 1) =>
    ops.push(c => { c.strokeStyle = color; c.lineWidth = width; c.beginPath(); c.moveTo(x1, yy); c.lineTo(x2, yy); c.stroke(); });
  const box = (x, yy, w, h) => ops.push(c => { c.strokeStyle = COLORS.line; c.lineWidth = 1; c.strokeRect(x, yy, w, h); });

  newPage();
  const logoW = 220;
  const logoH = (logoW * logo.height) / logo.width;
  image(logo, (PAGE_W - logoW) / 2, y, logoW, logoH);
  y += logoH + 20;

  for (const line of def.preamble) {
    text(line, R, y, { size: 14 });
    y += 24;
  }
  y += 14;
  text(def.title, PAGE_W / 2, y, { size: 22, weight: 700, align: "center" });
  y += 22 * 1.5 + 18;

  const bodySize = 15;
  const lineH = bodySize * 1.75;
  for (const line of renderFormBody(def, values)) {
    if (line.signature) {
      const boxW = 280, boxH = 120;
      if (!fits(boxH + 16)) newPage();
      y += 8;
      ctx.font = font(bodySize);
      const labelW = ctx.measureText(line.text).width;
      const sigRight = R - labelW - 16;
      const scale = Math.min(boxW / signature.width, boxH / signature.height);
      const sigW = signature.width * scale, sigH = signature.height * scale;
      image(signature, sigRight - sigW, y + boxH - sigH, sigW, sigH);
      text(line.text, R, y + boxH - lineH, { size: bodySize });
      rule(sigRight - boxW, sigRight, y + boxH + 2, COLORS.muted);
      y += boxH + 14;
      continue;
    }
    for (const part of wrapText(ctx, line.text, W, font(bodySize))) {
      if (!fits(lineH)) newPage();
      text(part, R, y, { size: bodySize });
      y += lineH;
    }
    y += 4;
  }

  const recordLineH = 11 * 1.7;
  const record = [
    { str: "רישום חתימה", weight: 700 },
    { str: `תאריך ושעה: ${israelDateTime(signedAt)} (שעון ישראל)` },
    { str: `סוג טופס: ${def.title}` },
    { str: `טלפון העובד שיצר את הקישור: ${workerPhone || "לא ידוע"}` },
    { str: "SHA-256 של תוכן הטופס:" },
    { str: hash, dir: "ltr", size: 10 },
  ];
  const recordH = record.length * recordLineH + 20;
  y += 24;
  if (!fits(recordH)) newPage();
  const recordY = Math.max(y, bottom - recordH);
  box(L, recordY, W, recordH);
  record.forEach(({ str, weight = 400, dir = "rtl", size = 11 }, i) =>
    text(str, R - 12, recordY + 10 + i * recordLineH, { size, weight, dir, color: COLORS.muted }));

  const images = [];
  for (const pageOps of pages) {
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    for (const op of pageOps) op(ctx);
    images.push(new Uint8Array(await canvas.encode("jpeg", 90)));
  }
  const blob = jpegPagesToPdf(images, canvas.width, canvas.height);
  return new Uint8Array(await blob.arrayBuffer());
}
