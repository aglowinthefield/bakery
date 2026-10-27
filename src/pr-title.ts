/**
 * The semantic-PR title rules a repository enforces, read from its amannn/action-semantic-pull-request workflow
 * or a Semantic Pull Requests app config. Shared by the server (which refuses a bad title before pushing) and the
 * Approve dialog (which flags it while the operator edits).
 */
export type SemanticTitleRules = {
  types: string[];
  scopes: string[];
  requireScope: boolean;
  source: string;
};

// amannn/action-semantic-pull-request's default types when the workflow lists none.
export const defaultSemanticTypes = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

/** Returns why `title` would fail the semantic-PR check, or "" when it passes. */
export function semanticTitleProblem(
  title: string,
  rules: SemanticTitleRules,
): string {
  const header = title.trim();
  const match = header.match(/^([\w-]+)(?:\(([^()]*)\))?(!)?: (\S.*)$/);
  const shape = rules.requireScope
    ? "type(scope): subject"
    : "type(scope): subject or type: subject";
  if (!match) return `Title must look like "${shape}"`;
  const [, type, scope] = match;
  if (rules.types.length && !rules.types.includes(type))
    return `Unknown type "${type}"; use one of ${rules.types.join(", ")}`;
  if (scope === undefined || !scope.trim()) {
    return rules.requireScope
      ? `A scope is required: "${shape}"`
      : scope === undefined
        ? ""
        : "Remove the empty parentheses or name a scope";
  }
  if (rules.scopes.length) {
    const unknown = scope
      .split(",")
      .map((item) => item.trim())
      .find((item) => !rules.scopes.includes(item));
    if (unknown !== undefined)
      return `Unknown scope "${unknown}"; use one of ${rules.scopes.join(", ")}`;
  }
  return "";
}
