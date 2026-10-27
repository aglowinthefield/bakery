import type { DiffLine } from "./diff-lines.js";

export type DiffSide = "additions" | "deletions";
export type DiffTarget = { side: DiffSide; lineNumber: number };

// Bakery stores one file's patch. Fixtures and some git output omit the file header,
// which the diff renderer needs to name the file and pick a language.
export function withFileHeader(path: string, patch: string): string {
  if (/^(diff --git |--- )/m.test(patch.split("@@")[0] ?? "")) return patch;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}`;
}

// Comments are keyed by 1-based diff row on the server. The renderer addresses lines
// by side and file line number, so translate between the two.
export function targetForRow(rows: DiffLine[], row: number): DiffTarget | null {
  const line = rows[row - 1];
  if (!line || line.kind === "meta") return null;
  if (line.kind === "remove") return { side: "deletions", lineNumber: line.oldLine! };
  return { side: "additions", lineNumber: line.newLine! };
}

export function rowForTarget(rows: DiffLine[], side: DiffSide | undefined, lineNumber: number): number | null {
  const index = rows.findIndex((line) =>
    side === "deletions"
      ? line.kind !== "add" && line.kind !== "meta" && line.oldLine === lineNumber
      : line.kind !== "remove" && line.kind !== "meta" && line.newLine === lineNumber,
  );
  return index === -1 ? null : index + 1;
}

export function diffStats(rows: DiffLine[]): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const line of rows) {
    if (line.kind === "add") additions++;
    else if (line.kind === "remove") deletions++;
  }
  return { additions, deletions };
}
