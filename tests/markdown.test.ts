import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToPlainText, parseMarkdown } from "../src/markdown.js";

test("parses headings, paragraphs with line breaks, rules, and fenced code", () => {
  assert.deepEqual(parseMarkdown("# Title\n\nFirst line\nsecond line\n\n---\n\n```ts\nconst x = '<b>';\n```"), [
    { type: "heading", level: 1, children: [{ type: "text", text: "Title" }] },
    { type: "paragraph", children: [{ type: "text", text: "First line" }, { type: "break" }, { type: "text", text: "second line" }] },
    { type: "rule" },
    { type: "code", lang: "ts", text: "const x = '<b>';" },
  ]);
  assert.deepEqual(parseMarkdown("Setext\n===")[0], { type: "heading", level: 1, children: [{ type: "text", text: "Setext" }] });
  assert.deepEqual(parseMarkdown("~~~\nunclosed *code*")[0], { type: "code", lang: "", text: "unclosed *code*" });
});

test("parses nested, ordered, and task lists", () => {
  const [list] = parseMarkdown("- one\n  - nested\n- [x] done\n- [ ] todo\n\n3. three\n4. four");
  assert.equal(list.type, "list");
  if (list.type !== "list") return;
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 3);
  assert.deepEqual(list.items[0].children[1], {
    type: "list", ordered: false, start: 1,
    items: [{ children: [{ type: "paragraph", children: [{ type: "text", text: "nested" }] }] }],
  });
  assert.deepEqual(list.items.slice(1).map(item => item.checked), [true, false]);
  const ordered = parseMarkdown("- a\n\n3. three\n4. four")[1];
  assert.deepEqual(ordered.type === "list" && [ordered.ordered, ordered.start, ordered.items.length], [true, 3, 2]);
  // An ordered marker other than 1 inside prose stays part of the paragraph.
  assert.equal(parseMarkdown("We shipped in\n2024. It went well.").length, 1);
});

test("parses blockquotes and inline formatting", () => {
  assert.deepEqual(parseMarkdown("> quoted **bold**"), [
    { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "quoted " }, { type: "strong", children: [{ type: "text", text: "bold" }] }] }] },
  ]);
  const [paragraph] = parseMarkdown("*a **b** c* `x*y` ~~gone~~ snake_case_name \\*literal\\*");
  assert.deepEqual(paragraph.type === "paragraph" && paragraph.children, [
    { type: "em", children: [{ type: "text", text: "a " }, { type: "strong", children: [{ type: "text", text: "b" }] }, { type: "text", text: " c" }] },
    { type: "text", text: " " },
    { type: "code", text: "x*y" },
    { type: "text", text: " " },
    { type: "del", children: [{ type: "text", text: "gone" }] },
    { type: "text", text: " snake_case_name *literal*" },
  ]);
});

test("links only allow web and mail targets", () => {
  const [paragraph] = parseMarkdown("[site](https://example.com/a_(b)) [bad](javascript:alert(1)) see https://example.com/x. <mailto:a@b.c>");
  assert.deepEqual(paragraph.type === "paragraph" && paragraph.children, [
    { type: "link", href: "https://example.com/a_(b)", children: [{ type: "text", text: "site" }] },
    { type: "text", text: " " },
    { type: "text", text: "bad" },
    { type: "text", text: " see " },
    { type: "link", href: "https://example.com/x", children: [{ type: "text", text: "https://example.com/x" }] },
    { type: "text", text: ". " },
    { type: "link", href: "mailto:a@b.c", children: [{ type: "text", text: "mailto:a@b.c" }] },
  ]);
});

test("raw HTML stays text", () => {
  assert.deepEqual(parseMarkdown("<script>alert(1)</script>"), [
    { type: "paragraph", children: [{ type: "text", text: "<script>alert(1)</script>" }] },
  ]);
});

test("plain-text previews drop markdown syntax", () => {
  assert.equal(markdownToPlainText("## Goal\n\nMake **cards** render [markdown](https://x.y).\n\n- one\n- two"), "Goal Make cards render markdown. one two");
  assert.equal(markdownToPlainText(""), "");
});

test("deep nesting is bounded", () => {
  assert.doesNotThrow(() => parseMarkdown(">".repeat(5000) + " deep"));
  assert.doesNotThrow(() => parseMarkdown("*".repeat(5000) + "x" + "*".repeat(5000)));
});

test("parses GFM tables with alignment, escaped pipes and code spans", () => {
  const blocks = parseMarkdown("Intro\n| A | B |\n|:--|--:|\n| `x|y` | a \\| b |\n| short |\n\nAfter");
  assert.equal(blocks.length, 3);
  const table = blocks[1];
  assert.equal(table.type, "table");
  if (table.type !== "table") return;
  assert.deepEqual(table.align, ["left", "right"]);
  assert.deepEqual(table.rows[0], [[{ type: "code", text: "x|y" }], [{ type: "text", text: "a | b" }]]);
  assert.deepEqual(table.rows[1][1], []);
  assert.equal(markdownToPlainText("| A | B |\n|---|---|\n| 1 | 2 |"), "A B 1 2");
  // A lone pipe line without a delimiter row stays a paragraph.
  assert.equal(parseMarkdown("a | b\nc | d")[0].type, "paragraph");
});
