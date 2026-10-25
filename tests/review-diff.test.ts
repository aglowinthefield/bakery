import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightDiffCode, parseDiff, languageForPath } from "../src/review-diff.js";

test("diff metadata stays neutral while additions and deletions are distinct", () => {
  const lines = parseDiff([
    "diff --git a/code.ts b/code.ts",
    "index aaaa..bbbb 100644",
    "--- a/code.ts",
    "+++ b/code.ts",
    "@@ -1,2 +1,2 @@",
    "-const old = 1;",
    "+const next = 2;",
    " context();",
    "\\ No newline at end of file",
  ].join("\n"));
  assert.deepEqual(lines.map(line => line.kind), ["meta", "meta", "meta", "meta", "meta", "remove", "add", "context", "meta"]);
  assert.deepEqual(lines.slice(5, 8).map(line => line.code), ["const old = 1;", "const next = 2;", "context();"]);
  assert.equal(parseDiff("diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ").every(line => line.kind === "meta"), true);
});

test("syntax highlights known languages and escapes untrusted patch contents", () => {
  assert.equal(languageForPath("src/main.tsx"), "typescript");
  assert.equal(languageForPath("src/style.css"), "css");
  assert.equal(languageForPath("assets/photo.png"), null);
  assert.match(highlightDiffCode("const next = 2;", "src/main.tsx"), /hljs-keyword[^>]*>const<\/span>/);
  assert.equal(highlightDiffCode("<img src=x onerror=alert(1)>", "assets/file.unknown"), "&lt;img src=x onerror=alert(1)&gt;");
  assert.doesNotMatch(highlightDiffCode("const x = '<script>';", "src/main.tsx"), /<script>/);
});
