import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardLinks, Markdown } from "../src/markdown-view.js";

const id = "38bdc7df-d492-4053-bdfb-bcfd1ee7d3fd";

test("a card id in markdown becomes a short chip that opens the card", () => {
  const source = `Part of the plan from card ${id}: Plan it`;
  const linked = renderToStaticMarkup(
    createElement(CardLinks.Provider, { value: { open: () => {}, title: () => "Plan it" } }, createElement(Markdown, { source })),
  );
  assert.match(linked, /<button[^>]*title="Plan it \(38bdc7df-[^"]*\)"[^>]*>38bdc7df<\/button>/);
  assert.doesNotMatch(linked, />38bdc7df-d492/);
  const plain = renderToStaticMarkup(createElement(Markdown, { source }));
  assert.match(plain, /<code[^>]*>38bdc7df<\/code>/);
});

import { latestNarration } from "../src/card-details.js";

test("the live status shows the agent's latest sentence, trimmed", () => {
  assert.equal(latestNarration(null), "");
  assert.equal(latestNarration("Checked the schema.\n\nNext I will run the **coverage** query. It may be slow."), "It may be slow.");
  assert.equal(latestNarration("- Reading `a.ts` now"), "Reading a.ts now");
  assert.ok(latestNarration("x".repeat(400)).length <= 180);
});
