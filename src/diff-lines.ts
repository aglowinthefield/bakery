export type DiffLine = { kind: "meta" | "add" | "remove" | "context"; code: string; prefix: string; oldLine?: number; newLine?: number };
export function parseDiff(patch: string): DiffLine[] {
  if (!patch) return [];
  let inHunk = false, oldLine = 0, newLine = 0;
  return patch.split("\n").map(line => {
    if (line.startsWith("diff --git ")) inHunk = false;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { inHunk = true; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { kind: "meta", code: line, prefix: "" }; }
    if (!inHunk || line.startsWith("\\ No newline at end of file")) return { kind: "meta", code: line, prefix: "" };
    const kind = line[0] === "+" ? "add" : line[0] === "-" ? "remove" : line[0] === " " ? "context" : "meta";
    if (kind === "meta") return { kind, code: line, prefix: "" };
    const result: DiffLine = { kind, code: line.slice(1), prefix: line[0] };
    if (kind !== "add") result.oldLine = oldLine++;
    if (kind !== "remove") result.newLine = newLine++;
    return result;
  });
}
