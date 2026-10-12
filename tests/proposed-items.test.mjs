import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanResult, formatProposedItemsReply } from "../src/proposed-items.mjs";

test("cleanResult sanitizes items, validates subchapters, units and non-empty descriptions", () => {
  const input = {
    items: [
      { subchapter: 1, unit: "03", quantity: 15, description: "פירוק ריצוף קיים" },
      { subchapter: 11, unit: "03", quantity: -5, description: "צביעה" },
      { subchapter: 999, unit: "03", quantity: 10, description: "לא קיים" },
      { subchapter: 1, unit: "99", quantity: 10, description: "יחידה לא קיימת" },
      { subchapter: 1, unit: "03", quantity: 10, description: "   " },
    ],
  };

  const result = cleanResult(input, "תמלול בדיקה");
  assert.equal(result.transcript, "תמלול בדיקה");
  assert.equal(result.items.length, 2);

  assert.deepEqual(result.items[0], {
    subchapter: 1,
    unit: "03",
    quantity: 15,
    description: "פירוק ריצוף קיים",
  });

  // Negative quantity resets to 0
  assert.deepEqual(result.items[1], {
    subchapter: 11,
    unit: "03",
    quantity: 0,
    description: "צביעה",
  });
});

test("formatProposedItemsReply formats items grouped by subchapter and marks missing quantities", () => {
  const items = [
    { subchapter: 1, unit: "03", quantity: 15, description: "פירוק ריצוף קיים" },
    { subchapter: 1, unit: "02", quantity: 0, description: "פירוק פנלים" },
    { subchapter: 10, unit: "03", quantity: 20, description: "ריצוף גרניט פורצלן" },
  ];

  const reply = formatProposedItemsReply(items);
  assert.ok(reply.includes("*עבודות פרוק והריסה:*"));
  assert.ok(reply.includes("• פירוק ריצוף קיים: 15 מ\"ר"));
  assert.ok(reply.includes("• פירוק פנלים: מ\"א (כמות לא צוינה)"));
  assert.ok(reply.includes("*עבודות ריצוף וחיפוי:*"));
  assert.ok(reply.includes("• ריצוף גרניט פורצלן: 20 מ\"ר"));
});

test("formatProposedItemsReply returns friendly message when no items found", () => {
  assert.equal(formatProposedItemsReply([]), "לא זוהו סעיפי עבודה בתיאור שנמסר.");
  assert.equal(formatProposedItemsReply(null), "לא זוהו סעיפי עבודה בתיאור שנמסר.");
});
