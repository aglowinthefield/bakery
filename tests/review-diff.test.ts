import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightDiffCode, languageForPath } from "../src/review-diff.js";
import { parseDiff } from "../src/diff-lines.js";

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
  assert.deepEqual(lines.slice(5, 8).map(line => [line.oldLine, line.newLine]), [[1, undefined], [undefined, 1], [2, 2]]);
  const multiHunk = parseDiff("@@ -20,1 +8,2 @@\n-kept\n+replaced\n+extra\n@@ -40 +90 @@\n still here");
  assert.deepEqual(multiHunk.filter(line => line.kind !== "meta").map(line => [line.oldLine, line.newLine]), [[20, undefined], [undefined, 8], [undefined, 9], [40, 90]]);
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

test("review comment rows map to renderer lines and back", async () => {
  const { diffStats, rowForTarget, targetForRow, withFileHeader } = await import("../src/review-patch.js");
  const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -4,3 +4,3 @@\n keep\n-old\n+new\n tail";
  const rows = parseDiff(patch);
  assert.deepEqual(targetForRow(rows, 5), { side: "additions", lineNumber: 4 });
  assert.deepEqual(targetForRow(rows, 6), { side: "deletions", lineNumber: 5 });
  assert.deepEqual(targetForRow(rows, 7), { side: "additions", lineNumber: 5 });
  assert.equal(targetForRow(rows, 4), null, "hunk headers are not commentable");
  for (const row of [5, 6, 7, 8]) {
    const target = targetForRow(rows, row)!;
    assert.equal(rowForTarget(rows, target.side, target.lineNumber), row);
  }
  assert.equal(rowForTarget(rows, "deletions", 4), 5, "context lines are reachable from the old side");
  assert.equal(rowForTarget(rows, "additions", 99), null);
  assert.deepEqual(diffStats(rows), { additions: 1, deletions: 1 });
  assert.equal(withFileHeader("a.ts", patch), patch);
  assert.equal(withFileHeader("src/b.ts", "@@ -0,0 +1 @@\n+x\n"), "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+x\n");
});
