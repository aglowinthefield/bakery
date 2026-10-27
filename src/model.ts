import type { SemanticTitleRules } from "./pr-title.js";
import type { UsageFields } from "./usage.js";
import type { AgentModels } from "../server/agent-models.js";
import type { RepoColor, RepoIcon } from "./repo-appearance.js";

export type Status =
  | "triage"
  | "ready"
  | "running"
  | "review"
  | "failed"
  | "interrupted"
  | "done"
  | "archived";
export type Board = {
  id: string;
  repo: string;
  icon: RepoIcon;
  color: RepoColor;
  remoteUrl?: string;
  /** local: Approve merges into local main. github-pr: Approve opens a PR; Done once it merges on GitHub. */
  integration?: "local" | "github-pr";
  /** Why GitHub sync last failed; auto pickup waits while it is set. */
  integrationError?: string;
  /** The operator picked the integration mode; detection leaves it alone. */
  integrationChosen?: boolean;
  /** Whether GitHub main only accepts pull requests; null until Bakery could check. */
  githubMainProtected?: boolean | null;
  /** What the GitHub main check found, or why it could not run. */
  integrationNote?: string;
  autoCollapseEmptySwimlanes: boolean;
  autoReviewEnabled: boolean;
  verificationCommand: string;
  autoReviewEnabledAt: string | null;
  autoPickupEnabled: boolean;
  pickupConcurrency: number;
  pickupDailyLimit: number;
  autoPickupStarts: number;
  autoPickupNextAt: string | null;
  autoPickupEnabledAt: string | null;
  autoPickupError: string;
  pickupCostBudget?: number | null;
  cost24h?: number;
  autoPickupBudgetReached?: boolean;
  agentModels?: AgentModels;
  /** Per status; `review` counts only Review cards that need you, `reviewWaiting` the rest. */
  cardCounts?: Partial<Record<CountKey, number>>;
};
export type AutoReviewJob = {
  cardId: string;
  runId: string;
  state: "running" | "needs_human" | "merged";
  details: string;
  fingerprint: string;
  startedAt: string;
  finishedAt: string | null;
  agent: string;
  /** Restarts that cut this review off. */
  interruptions: number;
  /** 1 when a restart cut the review off and it is queued to run again. */
  requeued: number;
} & UsageFields;
export type BakerySettings = {
  confirmRunStart: boolean;
  notifyOnReview: boolean;
  cardDetailsLayout: "dialog" | "side";
  theme: "default" | "compline" | "light" | "hearth";
  density: "compact" | "default" | "cozy";
  agentModels?: AgentModels;
};
export type ReviewComment = {
  id: string;
  cardId: string;
  runId: string;
  fingerprint: string;
  path: string;
  line: number;
  fileLine: number | null;
  kind: "add" | "remove" | "context";
  code: string;
  body: string;
  state: "draft" | "requested";
  createdAt: string;
};
export type MergeConflict = {
  cardId: string;
  files: string[];
  details: string;
};
/** The Approve dialog's starting point for a new pull request; see server/pr-draft.ts. */
export type PullRequestDraft = {
  title: string;
  body: string;
  source: "agent" | "card";
  problem: string;
  templatePath: string | null;
  semantic: SemanticTitleRules | null;
};
export type ReviewDiff = {
  cardId: string;
  fingerprint: string;
  files: { path: string; patch: string }[];
};
// Mirrors server/board.ts: stored as an integer, higher is picked up first.
export const priorities = [
  { value: 2, name: "urgent", label: "Urgent" },
  { value: 1, name: "high", label: "High" },
  { value: 0, name: "normal", label: "Normal" },
  { value: -1, name: "low", label: "Low" },
] as const;
export type Priority = (typeof priorities)[number]["value"];
export const priorityLabel = (value: number) =>
  priorities.find((item) => item.value === value)?.label ?? "Normal";
// Stable sort: equal priorities keep the server's existing order.
export const byPriority = <T extends { priority?: number }>(items: T[]) =>
  [...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
export type Card = {
  id: string;
  title: string;
  body: string;
  repo: string;
  source: "manual";
  idempotencyKey?: string | null;
  status: Status;
  priority: Priority;
  createdAt: string;
  updatedAt: string;
  turns: number;
  turnsIncomplete: number;
  attempts: number;
  reviewRounds: number;
  runAgent: string;
  reviewAgent: string;
  usageIncomplete?: number;
  /** Cards on the same board that must be Done or archived before this one starts. */
  dependsOn?: string[];
  /** True while any card in dependsOn is not Done or archived. */
  blocked?: boolean;
  /** A PR link attached by the operator; overrides the bakery/<id> branch lookup. */
  prOverrideUrl?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  prState?: "OPEN" | "CLOSED" | "MERGED" | null;
  prChecks?: string | null;
  prError?: string | null;
  /**
   * Local boards with a GitHub remote: whether this Done card's merge commit is on origin/main,
   * as of the last fetch. "local" means merged into local main but not pushed.
   */
  originMain?: "pushed" | "local";
  /** Times Bakery sent this card back because its PR failed CI. */
  ciReworks?: number;
  /** Bakery merged this card into local main (local integration), not through a PR. */
  locallyMerged?: boolean;
  /** Set on Review cards that are not your turn yet; see `reviewWaitLabels`. */
  reviewWait?: ReviewWait | null;
  /** Last time the latest run's agent reported anything. */
  lastActivityAt?: string | null;
} & UsageFields;
export type CountKey = Status | "reviewWaiting";
/** The `cardCounts` bucket a card falls in. */
export const countKey = (card: Card): CountKey =>
  card.status === "review" && card.reviewWait ? "reviewWaiting" : card.status;
export type ReviewWait = "agent_review" | "ci_fix" | "github";
export const reviewWaitLabels: Record<ReviewWait, string> = {
  agent_review: "Agent reviewing",
  ci_fix: "CI fix queued",
  github: "Waiting on GitHub",
};
/** A Review card you can act on now, rather than one an agent, CI or GitHub still has. */
export const needsYourReview = (card: Card) =>
  card.status === "review" && !card.reviewWait;
/** A running agent silent for this long is shown as quiet. Long tool calls (a test suite) can be quiet too. */
export const quietAfterMs = 5 * 60_000;
/**
 * Whether work is happening on the card right now: an agent is `working`, the card is `waiting` on something
 * outside Bakery, or a running agent has gone `quiet`. Null when nothing is in flight.
 */
export function cardActivity(
  card: Card,
  now = Date.now(),
): "working" | "waiting" | "quiet" | null {
  if (card.status === "running")
    return card.lastActivityAt &&
      now - Date.parse(card.lastActivityAt) > quietAfterMs
      ? "quiet"
      : "working";
  if (card.status === "review" && card.reviewWait)
    return card.reviewWait === "agent_review" ? "working" : "waiting";
  return null;
}
/**
 * Lanes a board card can be dragged to. Mirrors the card's own buttons: Move to Ready or Triage,
 * Mark done (never-run cards only), Start or Run again, Archive, and Restore to Done. Moves that need
 * a diff review, an approval, or a worktree check (Review, Interrupted, Reopen) stay as buttons.
 */
export function dropTargets(card: Card): Status[] {
  const unrun = !card.attempts;
  switch (card.status) {
    case "triage":
      return unrun ? ["ready", "done"] : ["ready"];
    case "ready":
      return unrun ? ["triage", "running", "done"] : ["running"];
    case "failed":
      return ["running"];
    case "done":
      return ["archived"];
    case "archived":
      return ["done"];
    default:
      return [];
  }
}
const finished = (status: Status) => status === "done" || status === "archived";
/**
 * The cards this card still waits on, from the cards the page already has. Only Today's list
 * leaves cards out, and only archived (finished) ones, so a missing dependency is skipped.
 */
export const waitingOn = (card: Card, cards: Card[]) =>
  card.blocked
    ? (card.dependsOn ?? [])
        .map((id) => cards.find((item) => item.id === id))
        .filter((item): item is Card => !!item && !finished(item.status))
    : [];
export type Run = {
  id: string;
  attempt: number;
  status: Status;
  output: string;
  error: string | null;
  worktree: string | null;
  startedAt: string;
  finishedAt: string | null;
  startedBy: "manual" | "auto";
  agent: string;
  /** The agent's final message, in markdown. Null for runs that never replied. */
  report: string | null;
} & UsageFields;
