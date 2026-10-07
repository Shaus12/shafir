#!/usr/bin/env node
// Inspect an SKN file:  node src/skn/cli.mjs <file.skn> [--json]
import { readFileSync } from "node:fs";
import { parseSkn, entries, totals } from "./skn.mjs";

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node src/skn/cli.mjs <file.skn> [--json]");
  process.exit(1);
}

const doc = parseSkn(readFileSync(file));
const all = entries(doc);

if (flag === "--json") {
  console.log(JSON.stringify({ eol: doc.eol === "\r\n" ? "CRLF" : "LF", align: doc.align, codeWidth: doc.codeWidth, entries: all }, null, 2));
  process.exit(0);
}

const money = n => n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const indent = { root: "", building: "", chapter: "  ", subchapter: "    ", item: "      " };
for (const e of all) {
  if (e.level === "item" && e.qty > 0) {
    const line = `${e.code}  ${(e.unitName ?? e.unit).padEnd(6)} ${String(e.qty).padStart(9)} × ${money(e.price).padStart(12)} = ${money(e.qty * e.price).padStart(14)}`;
    console.log(`${indent.item}${line}  ${e.description.slice(0, 70)}`);
  } else if (e.description) {
    console.log(`${indent[e.level] ?? ""}${e.code ?? ""}  ${e.description}`);
  }
}
const t = totals(doc);
console.log(`\nסה"כ: ${money(t.total)} ₪  ·  סעיפים ללא מחיר: ${t.unpriced}`);
