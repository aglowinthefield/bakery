import { test } from "node:test";
import assert from "node:assert/strict";
import { githubMarkdown } from "../server/github-markdown.js";
import { pullRequestBody } from "../server/pr-draft.js";

const shot = "![before.png](/api/boards/b1/cards/c1/attachments/a1)";

test("githubMarkdown replaces Bakery-relative image and file links with text that names the file", () => {
  const out = githubMarkdown(
    `Before:\n${shot}\n[run.log](/api/boards/b1/cards/c1/attachments/a2)`,
  );
  assert.doesNotMatch(out, /\/api\//);
  assert.match(
    out,
    /Screenshot before\.png: kept in Bakery.*not published to GitHub/,
  );
  assert.match(out, /run\.log \(kept in Bakery as a card attachment/);
});

test("githubMarkdown leaves external links, code and plain text alone", () => {
  const text =
    "![ok](https://example.com/a.png) [d](https://github.com/x)\n\n```\n![a](/api/x)\n```\n\nUse `![a](/api/x)` literally.";
  assert.equal(githubMarkdown(text), text);
});

test("a pull request body built from a report carries no relative attachment URL", () => {
  const body = pullRequestBody(
    `Summary\n\n${shot}`,
    { id: "c1" },
    { output: `Report\n${shot}` },
  );
  assert.doesNotMatch(body, /\(\/api\//);
  assert.match(body, /before\.png/);
  assert.match(body, /Opened by Bakery for card `c1`/);
});

test("githubMarkdown leaves unrelated /api links alone and rewrites chat images", () => {
  const text = "[API documentation](/api/users) and [x](/api/boards/b/cards/c/review)";
  assert.equal(githubMarkdown(text), text);
  assert.doesNotMatch(githubMarkdown(`![c](/api/boards/b/chats/c/images/${"a".repeat(64)})`), /\/api\//);
});

test("githubMarkdown rewrites a link whose label holds code, but not a link written inside code", () => {
  const out = githubMarkdown("![Screenshot of `button`](/api/boards/b/cards/c/attachments/a)");
  assert.doesNotMatch(out, /\/api\//);
  assert.match(out, /Screenshot of button/);
  const code = "`![a](/api/boards/b/cards/c/attachments/a)`";
  assert.equal(githubMarkdown(code), code);
});
