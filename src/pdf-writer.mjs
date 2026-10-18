// Hebrew-safe PDFs: pages are drawn on a canvas (browser or @napi-rs/canvas), which orders Hebrew
// correctly, and each page is embedded as a full-page JPEG in a minimal PDF.

/** Word-wrap `text` to `width` with the given canvas font. Over-long words are broken by character. */
export function wrapText(ctx, text, width, fontSpec) {
  ctx.font = fontSpec;
  const lines = [];
  let line = "";
  const breakWord = word => {
    let part = "";
    for (const ch of word) {
      if (part && ctx.measureText(part + ch).width > width) { lines.push(part); part = ch; } else part += ch;
    }
    return part;
  };
  for (const word of String(text ?? "").split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= width) { line = candidate; continue; }
    if (line) lines.push(line);
    line = ctx.measureText(word).width <= width ? word : breakWord(word);
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

/** A minimal PDF with one full-page JPEG per A4 page. */
export function jpegPagesToPdf(images, pixelWidth, pixelHeight) {
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = chunk => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (id, ...body) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    body.forEach(push);
    push("\nendobj\n");
  };
  const pageW = 595.28, pageH = 841.89;
  const pageIds = images.map((_, i) => 3 + i * 3);

  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${images.length} >>`);
  images.forEach((jpeg, i) => {
    const id = pageIds[i];
    const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`);
    object(id + 1, `<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream");
    object(id + 2, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  const count = 3 + images.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
