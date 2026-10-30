import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { addAgent, type Usage } from "./agent.js";
import { parseAgentModels, resolveAgentModel, validateAgentModels, type AgentModel, type AgentModels, type AgentPhase } from "./agent-models.js";
import { githubRepo, parsePullRequestUrl } from "./github-url.js";
import type { ThemeName } from "../src/themes.js";
import { parsePlan } from "../src/plan.js";
import { repoColors, repoIcons, type RepoColor, type RepoIcon } from "../src/repo-appearance.js";
import type { StatsInput } from "./stats.js";

export type CardStatus = "triage" | "ready" | "running" | "review" | "failed" | "interrupted" | "done" | "archived";
export type RepoBoard = { id: string; repo: string; icon: RepoIcon; color: RepoColor; remoteUrl: string; autoCollapseEmptySwimlanes: boolean; autoReviewEnabled: boolean; verificationCommand: string; autoReviewEnabledAt: string | null; autoReviewMergeLimit: number; autoReviewMerges: number; autoPickupEnabled: boolean; pickupConcurrency: number; pickupDailyLimit: number; autoPickupStarts: number; autoPickupNextAt: string | null; autoPickupEnabledAt: string | null; autoPickupError: string; agentModels: AgentModels; pickupCostBudget: number | null; cost24h: number; autoPickupBudgetReached: boolean; integration: IntegrationMode; integrationError: string; integrationWarning: string; integrationSyncedAt: string | null; integrationChosen: boolean; githubMainProtected: boolean | null; integrationNote: string; pushMainAfterMerge: boolean };
/** `local` merges into local main on Approve; `github-pr` opens a PR and waits for it to merge on GitHub. */
export type IntegrationMode = "local" | "github-pr";
export type BakerySettings = { confirmRunStart: boolean; notifyOnReview: boolean; cardDetailsLayout: "dialog" | "side"; theme: ThemeName; density: "compact" | "default" | "cozy"; showCardModels: boolean; agentModels: AgentModels };
type BoardRow = { id: string; repo: string; icon: RepoIcon; color: RepoColor; remoteUrl: string; autoCollapseEmptySwimlanes: number; autoReviewEnabled: number; verificationCommand: string; autoReviewEnabledAt: string | null; autoReviewMergeLimit: number; autoPickupEnabled: number; pickupConcurrency: number; pickupDailyLimit: number; autoPickupResetRunRowid: number; autoPickupEnabledAt: string | null; autoPickupError: string; agentModels: string; pickupCostBudget: number | null; integration: IntegrationMode; integrationError: string; integrationWarning: string; integrationSyncedAt: string | null; integrationChosen: number; githubMainProtected: number | null; integrationNote: string; pushMainAfterMerge: number };
const toRepoBoard = (row: BoardRow, starts: string[], cost24h: number, autoReviewMerges: number): RepoBoard => ({
  id: row.id, repo: row.repo, icon: row.icon, color: row.color, remoteUrl: row.remoteUrl, verificationCommand: row.verificationCommand,
  autoReviewEnabledAt: row.autoReviewEnabledAt, autoReviewMergeLimit: row.autoReviewMergeLimit, autoReviewMerges, pickupConcurrency: row.pickupConcurrency,
  pickupDailyLimit: row.pickupDailyLimit, autoPickupEnabledAt: row.autoPickupEnabledAt, autoPickupError: row.autoPickupError,
  autoCollapseEmptySwimlanes: row.autoCollapseEmptySwimlanes !== 0, pushMainAfterMerge: row.pushMainAfterMerge !== 0,
  autoReviewEnabled: row.autoReviewEnabled !== 0, autoPickupEnabled: row.autoPickupEnabled !== 0,
  autoPickupStarts: starts.length, agentModels: parseAgentModels(row.agentModels),
  autoPickupNextAt: row.pickupDailyLimit > 0 && starts.length >= row.pickupDailyLimit
    ? new Date(Date.parse(starts[starts.length - row.pickupDailyLimit]) + 86_400_000).toISOString() : null,
  pickupCostBudget: row.pickupCostBudget, cost24h, integration: row.integration, integrationError: row.integrationError, integrationWarning: row.integrationWarning, integrationSyncedAt: row.integrationSyncedAt,
  integrationChosen: row.integrationChosen !== 0, githubMainProtected: row.githubMainProtected === null ? null : row.githubMainProtected !== 0, integrationNote: row.integrationNote,
  autoPickupBudgetReached: row.pickupCostBudget !== null && cost24h >= row.pickupCostBudget,
});
// Token and cost columns are NULL for attempts recorded before Bakery tracked usage; new attempts start at 0.
const usageColumns = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"] as const;
type UsageFields = { [Key in keyof Usage]: number | null };
const usageDefinitions = "inputTokens INTEGER, outputTokens INTEGER, cacheReadTokens INTEGER, cacheWriteTokens INTEGER, cost REAL";
const usageUpdate = usageColumns.map(column => `${column}=COALESCE(${column}, 0)+?`).join(", ");
const usageValues = (usage: Usage) => usageColumns.map(column => usage[column]);
// A card's usage sums its attempts and agent reviews; usageIncomplete is 1 when an older one has no record.
// Stored as an integer so pickup and lanes can ORDER BY it; higher runs first.
// A whole number from -100 to 100 (default 0). The names are shorthands for the CLI and API.
export const cardPriorities = { low: -10, normal: 0, high: 50, urgent: 100 } as const;
export type CardPriorityName = keyof typeof cardPriorities;
export type CardPriority = number;
export const PRIORITY_MIN = -100, PRIORITY_MAX = 100;
export function parsePriority(value: unknown): CardPriority {
  if (typeof value === "string" && Object.hasOwn(cardPriorities, value)) return cardPriorities[value as CardPriorityName];
  if (typeof value === "number" && Number.isInteger(value) && value >= PRIORITY_MIN && value <= PRIORITY_MAX) return value;
  throw new Error("Priority must be a whole number from -100 to 100, or low, normal, high, or urgent");
}
/** The pull request linked to a card on a github-pr board. `prOverrideUrl` replaces the branch lookup. */
/**
 * `prPushedRunId` is the run whose work Approve last pushed to the PR; a newer run needs Approve again.
 * `prCiPending` is set while Bakery holds a CI failure to send back to Pi (waiting for the other checks to settle).
 */
export type CardPullRequest = { prOverrideUrl: string | null; prNumber: number | null; prUrl: string | null; prState: "OPEN" | "CLOSED" | "MERGED" | null; prChecks: string | null; prError: string | null; ciReworks: number; ciReworkSha: string | null; prPushedRunId: string | null; prCiPending: number; conflictRepairs: number; conflictRepairKey: string | null };
/**
 * Why a Review card is not waiting for a person: an agent is reviewing it (or is about to), Bakery is about to send
 * its failing CI back to Pi, or its PR is waiting on GitHub (checks, merge queue, the merge reaching main).
 */
export type ReviewWait = "agent_review" | "ci_fix" | "github";
export type Card = { id: string; title: string; body: string; repo: string; status: CardStatus; source: "manual"; priority: CardPriority; idempotencyKey: string | null;
  /** Cards made from this card's plan report; null until the plan is used. Stays set if those cards are deleted. */
  createdCardIds: string[] | null; createdAt: string; updatedAt: string; turns: number; turnsIncomplete: number; attempts: number; reviewRounds: number; runAgent: string; reviewAgent: string; usageIncomplete: number; dependsOn: string[]; blocked: boolean; locallyMerged: boolean; planOnly: boolean;
  /** Last time the latest run's agent reported anything; null before the first run. */
  lastActivityAt: string | null;
  /** Set only for Review cards that are not your turn; null means a person is needed (or the card is not in Review). */
  reviewWait: ReviewWait | null;
  /** A start was asked for during a restart drain and runs after the restart. */
  startQueued: boolean;
  /** Files attached to the card, including those sent with discussion messages. */
  attachmentCount: number;
  /** Done cards on a local board with a GitHub remote: is the merge on origin/main (last fetch)? */
  originMain?: "pushed" | "local" } & UsageFields & CardPullRequest;
/** A card on the other end of a dependency edge, with enough to show and link it. */
export type CardRef = { id: string; title: string; status: CardStatus };
// A dependency is finished once it is Done or archived. Until then the dependent card is blocked.
const finishedStatuses = "('done', 'archived')";
/** Unstarted blocked cards wait; a card that already has attempts has its worktree and may retry. */
export const waitsOnDependencies = (card: Pick<Card, "blocked" | "attempts">) => card.blocked && card.attempts === 0;
type CardRow = Omit<Card, "dependsOn" | "blocked" | "reviewWait" | "startQueued" | "locallyMerged" | "planOnly" | "createdCardIds"> & { createdCardIds: string | null; dependsOn: string; blocked: number; locallyMerged: number; planOnly: number };
/** A file on a card. `messageId` is set when it was sent with a discussion message. */
export type Attachment = { id: string; cardId: string; messageId: string | null; name: string; type: string; size: number; createdAt: string };
export type DiscussionMessage = { id: string; cardId: string; role: "user" | "agent" | "error"; body: string; createdAt: string; attachments: Attachment[] };
/** A board chat: a general agent session about one repo and its board. Pi keeps the conversation; Bakery keeps what to show. */
export type Chat = { id: string; boardId: string; title: string; createdAt: string; updatedAt: string };
/** What an agent turn did, in order: reply text and the tools it ran. */
export type ChatPart = { type: "text"; text: string } | { type: "tool"; id: string; name: string; input: string; output: string; status: "running" | "done" | "error" };
export type ChatMessage = { id: string; chatId: string; role: "user" | "agent" | "error"; body: string; parts: ChatPart[]; createdAt: string };
export type Run = { id: string; cardId: string; attempt: number; status: "running" | "review" | "failed" | "interrupted"; pid: number | null; worktree: string | null; sessionId: string; output: string; error: string | null; startedAt: string; finishedAt: string | null; turns: number; turnsIncomplete: number; startedBy: "manual" | "auto"; agent: string; lastActivityAt: string | null; ciFix: number; report: string | null } & UsageFields;
export type Approval = { cardId: string; runId: string; candidate: string; preparedHead: string | null; merged: number };
export type AutoReviewJob = { cardId: string; runId: string; state: "running" | "needs_human" | "merged"; details: string; fingerprint: string; startedAt: string; finishedAt: string | null; agent: string; interruptions: number; requeued: number; changes: string } & UsageFields;
export type MergeFailure = { cardId: string; files: string[]; details: string };
export type ReviewComment = { id: string; cardId: string; runId: string; fingerprint: string; path: string; line: number; fileLine: number | null; kind: "add" | "remove" | "context"; code: string; body: string; state: "draft" | "requested"; createdAt: string };
const boardFields = "id, repo, icon, color, remoteUrl, autoCollapseEmptySwimlanes, autoReviewEnabled, verificationCommand, autoReviewEnabledAt, autoReviewMergeLimit, autoPickupEnabled, pickupConcurrency, pickupDailyLimit, autoPickupResetRunRowid, autoPickupEnabledAt, autoPickupError, agentModels, pickupCostBudget, integration, integrationError, integrationWarning, integrationSyncedAt, integrationChosen, githubMainProtected, integrationNote, pushMainAfterMerge";
const now = () => new Date().toISOString();
/** A status change (fromStatus/toStatus set) or a note (both null), with why it happened. */
export type CardEvent = { at: string; fromStatus: CardStatus | null; toStatus: CardStatus | null; reason: string };
const cardQuery = `SELECT cards.*, COALESCE(SUM(runs.turns), 0) AS turns, COALESCE(MAX(runs.turnsIncomplete), 0) AS turnsIncomplete,
  COUNT(runs.id) AS attempts,
  (SELECT COUNT(*) FROM attachments a WHERE a.cardId=cards.id) AS attachmentCount,
  (SELECT COUNT(DISTINCT rc.runId) FROM review_comments rc WHERE rc.cardId=cards.id AND rc.state='requested') AS reviewRounds,
  COALESCE((SELECT latest.agent FROM runs latest WHERE latest.cardId=cards.id ORDER BY latest.attempt DESC LIMIT 1), '') AS runAgent,
  COALESCE((SELECT job.agent FROM auto_review_jobs job WHERE job.cardId=cards.id ORDER BY job.startedAt DESC LIMIT 1), '') AS reviewAgent,
  (SELECT latest.lastActivityAt FROM runs latest WHERE latest.cardId=cards.id ORDER BY latest.attempt DESC LIMIT 1) AS lastActivityAt,
  ${usageColumns.map(column => `MAX(spend.${column}) AS ${column}`).join(", ")}, COALESCE(MAX(spend.unrecorded), 0) AS usageIncomplete,
  (SELECT json_group_array(edge.dependsOn) FROM (SELECT d.dependsOn FROM card_dependencies d JOIN cards parent ON parent.id=d.dependsOn WHERE d.cardId=cards.id ORDER BY parent.createdAt, parent.rowid) edge) AS dependsOn,
  EXISTS (SELECT 1 FROM card_dependencies d JOIN cards parent ON parent.id=d.dependsOn WHERE d.cardId=cards.id AND parent.status NOT IN ${finishedStatuses}) AS blocked,
  EXISTS (SELECT 1 FROM approvals merged WHERE merged.cardId=cards.id AND merged.merged=1) AS locallyMerged,
  COALESCE((SELECT latest.report LIKE '%bakery-plan%' FROM runs latest WHERE latest.cardId=cards.id ORDER BY latest.attempt DESC LIMIT 1), 0) AS planOnly
  FROM cards LEFT JOIN runs ON runs.cardId=cards.id
  LEFT JOIN (SELECT cardId, ${usageColumns.map(column => `SUM(${column}) AS ${column}`).join(", ")}, MAX(cost IS NULL) AS unrecorded
    FROM (SELECT cardId, ${usageColumns.join(", ")} FROM runs UNION ALL SELECT cardId, ${usageColumns.join(", ")} FROM auto_review_jobs) GROUP BY cardId) spend ON spend.cardId=cards.id`;

/**
 * Older runs kept only the transcript. Their final message is the text after the last turn summary, since Bakery
 * writes a "Turn N:" line only for turns that used tools and the final reply uses none.
 */
export function reportFromOutput(output: string): string | null {
  const marker = [...output.matchAll(/(?:^|\n)Turn \d+:[^\n]*\n(?:worktree: [^\n]*\n)?/g)].at(-1);
  if (!marker) return null;
  return output.slice(marker.index + marker[0].length).trim() || null;
}

/** A chat's title from its first message: the first line, cut to 80 characters. */
export function chatTitle(message: string): string {
  const line = message.trim().split("\n")[0].trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** A run could not start because the repository already has as many runs as its auto-pickup concurrency allows. */
export class RunLimitError extends Error {}

export class Board {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, repo TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, cardId TEXT NOT NULL REFERENCES cards(id), attempt INTEGER NOT NULL, status TEXT NOT NULL, pid INTEGER, worktree TEXT, sessionId TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', error TEXT, startedAt TEXT, finishedAt TEXT, turns INTEGER NOT NULL DEFAULT 0, turnsIncomplete INTEGER NOT NULL DEFAULT 0, startedBy TEXT NOT NULL DEFAULT 'manual', ${usageDefinitions}, UNIQUE(cardId, attempt));
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, repo TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0, icon TEXT NOT NULL DEFAULT 'sprinkle_donut', color TEXT NOT NULL DEFAULT 'violet', remoteUrl TEXT NOT NULL DEFAULT '', autoCollapseEmptySwimlanes INTEGER NOT NULL DEFAULT 0, autoReviewEnabled INTEGER NOT NULL DEFAULT 0, verificationCommand TEXT NOT NULL DEFAULT '', autoReviewEnabledAt TEXT, autoPickupEnabled INTEGER NOT NULL DEFAULT 0, pickupConcurrency INTEGER NOT NULL DEFAULT 2, pickupDailyLimit INTEGER NOT NULL DEFAULT 6, autoPickupResetRunRowid INTEGER NOT NULL DEFAULT 0, autoPickupEnabledAt TEXT, autoPickupError TEXT NOT NULL DEFAULT '', autoPickupResumeOnResolution INTEGER NOT NULL DEFAULT 0, agentModels TEXT NOT NULL DEFAULT '{}', pickupCostBudget REAL);
      CREATE TABLE IF NOT EXISTS approvals (cardId TEXT PRIMARY KEY, runId TEXT NOT NULL, candidate TEXT NOT NULL, preparedHead TEXT, merged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS external_integrations (cardId TEXT PRIMARY KEY REFERENCES cards(id), runId TEXT NOT NULL REFERENCES runs(id), candidate TEXT NOT NULL, mergeCommit TEXT NOT NULL, integratedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queued_starts (cardId TEXT PRIMARY KEY REFERENCES cards(id), queuedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS merge_failures (cardId TEXT PRIMARY KEY, files TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_review_jobs (cardId TEXT NOT NULL, runId TEXT NOT NULL PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('running','needs_human','merged')), details TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '', startedAt TEXT NOT NULL, finishedAt TEXT, ${usageDefinitions});
      CREATE TABLE IF NOT EXISTS review_comments (id TEXT PRIMARY KEY, cardId TEXT NOT NULL REFERENCES cards(id), runId TEXT NOT NULL REFERENCES runs(id), fingerprint TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL, fileLine INTEGER, kind TEXT NOT NULL CHECK(kind IN ('add','remove','context')), code TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','requested')), createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_comments_card ON review_comments(cardId, runId, state);
      CREATE TABLE IF NOT EXISTS discussion_messages (id TEXT PRIMARY KEY, cardId TEXT NOT NULL REFERENCES cards(id), role TEXT NOT NULL CHECK(role IN ('user','agent','error')), body TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS discussion_messages_card ON discussion_messages(cardId, createdAt);
      -- Files the operator attached to a card, or to one of its discussion messages (messageId). The bytes live on disk; see server/attachments.ts.
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, cardId TEXT NOT NULL REFERENCES cards(id), messageId TEXT REFERENCES discussion_messages(id), name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attachments_card ON attachments(cardId, createdAt);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, boardId TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chats_board ON chats(boardId, updatedAt);
      CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','agent','error')), body TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chatId, createdAt);
      CREATE TABLE IF NOT EXISTS card_dependencies (cardId TEXT NOT NULL REFERENCES cards(id), dependsOn TEXT NOT NULL REFERENCES cards(id), PRIMARY KEY (cardId, dependsOn));
      CREATE INDEX IF NOT EXISTS card_dependencies_parent ON card_dependencies(dependsOn);
      DELETE FROM card_dependencies WHERE cardId NOT IN (SELECT id FROM cards) OR dependsOn NOT IN (SELECT id FROM cards);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), confirmRunStart INTEGER NOT NULL CHECK(confirmRunStart IN (0, 1)), cardDetailsLayout TEXT NOT NULL DEFAULT 'dialog' CHECK(cardDetailsLayout IN ('dialog', 'side')), theme TEXT NOT NULL DEFAULT 'default', notifyOnReview INTEGER NOT NULL DEFAULT 0 CHECK(notifyOnReview IN (0, 1)), agentModels TEXT NOT NULL DEFAULT '{}');
      INSERT OR IGNORE INTO settings(id, confirmRunStart) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS card_events (id INTEGER PRIMARY KEY AUTOINCREMENT, cardId TEXT NOT NULL, at TEXT NOT NULL, fromStatus TEXT, toStatus TEXT, reason TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS card_events_card ON card_events(cardId, id);
      -- Every status change lands here, whichever code path made it. The method that made it then fills in the reason (see explain).
      CREATE TRIGGER IF NOT EXISTS card_status_events AFTER UPDATE OF status ON cards WHEN OLD.status IS NOT NEW.status BEGIN
        INSERT INTO card_events(cardId, at, fromStatus, toStatus) VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.status, NEW.status);
      END;`);
    // Scripts may pass an idempotency key so a re-run returns the card it already created on that board.
    const cardColumns = new Set((this.db.prepare("PRAGMA table_info(cards)").all() as { name: string }[]).map(column => column.name));
    if (!cardColumns.has("priority")) this.db.exec("ALTER TABLE cards ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
    // Priorities used to be four levels (-1, 0, 1, 2); they are now numbers, so the old levels move to their shorthand values once.
    if ((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version < 1) {
      this.db.exec("UPDATE cards SET priority = CASE priority WHEN -1 THEN -10 WHEN 1 THEN 50 WHEN 2 THEN 100 ELSE priority END; PRAGMA user_version = 1");
    }
    if (!cardColumns.has("idempotencyKey")) this.db.exec("ALTER TABLE cards ADD COLUMN idempotencyKey TEXT");
    for (const column of ["prOverrideUrl TEXT", "prNumber INTEGER", "prUrl TEXT", "prState TEXT", "prChecks TEXT", "prError TEXT", "ciReworks INTEGER NOT NULL DEFAULT 0", "ciReworkSha TEXT", "prPushedRunId TEXT", "prCiPending INTEGER NOT NULL DEFAULT 0", "createdCardIds TEXT", "conflictRepairs INTEGER NOT NULL DEFAULT 0", "conflictRepairKey TEXT"])
      if (!cardColumns.has(column.split(" ")[0])) this.db.exec(`ALTER TABLE cards ADD COLUMN ${column}`);
    if (!cardColumns.has("prPushedRunId")) {
      // Before this column, a PR was opened from the latest run unless a CI fix run came after it. When a fix run may
      // have, the card stays unknown and shows as needing you (Approve pushes the fix) rather than silently waiting.
      this.db.exec(`UPDATE cards SET prPushedRunId=(SELECT id FROM runs WHERE runs.cardId=cards.id ORDER BY attempt DESC LIMIT 1)
        WHERE prNumber IS NOT NULL AND prOverrideUrl IS NULL AND (ciReworks=0 OR (SELECT COUNT(*) FROM runs WHERE runs.cardId=cards.id)=1)`);
    }
    // CI failures from a card's PR, waiting to be handed to the card's next run.
    this.db.exec("CREATE TABLE IF NOT EXISTS ci_feedback (cardId TEXT PRIMARY KEY REFERENCES cards(id), headSha TEXT NOT NULL, failures TEXT NOT NULL, createdAt TEXT NOT NULL)");
    // 'ci' for a PR's failed checks, 'push' for a pre-push hook that refused the push.
    if (!(this.db.prepare("PRAGMA table_info(ci_feedback)").all() as { name: string }[]).some(column => column.name === "source")) this.db.exec("ALTER TABLE ci_feedback ADD COLUMN source TEXT NOT NULL DEFAULT 'ci'");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS cards_idempotency_key ON cards(repo, idempotencyKey) WHERE idempotencyKey IS NOT NULL");
    const commentColumns = new Set((this.db.prepare("PRAGMA table_info(review_comments)").all() as { name: string }[]).map(column => column.name));
    if (!commentColumns.has("fileLine")) this.db.exec("ALTER TABLE review_comments ADD COLUMN fileLine INTEGER");
    const settingsColumns = new Set((this.db.prepare("PRAGMA table_info(settings)").all() as { name: string }[]).map(column => column.name));
    if (!settingsColumns.has("cardDetailsLayout")) this.db.exec("ALTER TABLE settings ADD COLUMN cardDetailsLayout TEXT NOT NULL DEFAULT 'dialog' CHECK(cardDetailsLayout IN ('dialog', 'side'))");
    if (!settingsColumns.has("theme")) {
      this.db.exec("ALTER TABLE settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'default'");
    } else {
      // Older theme columns carry a CHECK that rejects newer themes. Themes are
      // validated against src/themes.ts now, so rebuild the table without it.
      const schema = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'").get() as { sql: string }).sql;
      if (schema.includes("CHECK(theme")) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE settings_new (id INTEGER PRIMARY KEY CHECK(id=1), confirmRunStart INTEGER NOT NULL CHECK(confirmRunStart IN (0, 1)), cardDetailsLayout TEXT NOT NULL DEFAULT 'dialog' CHECK(cardDetailsLayout IN ('dialog', 'side')), theme TEXT NOT NULL DEFAULT 'default', notifyOnReview INTEGER NOT NULL DEFAULT 0 CHECK(notifyOnReview IN (0, 1)), agentModels TEXT NOT NULL DEFAULT '{}', density TEXT NOT NULL DEFAULT 'default' CHECK(density IN ('compact', 'default', 'cozy')));
          INSERT INTO settings_new SELECT id, confirmRunStart, cardDetailsLayout, CASE WHEN theme='dark' THEN 'default' ELSE theme END, ${settingsColumns.has("notifyOnReview") ? "notifyOnReview" : "0"}, ${settingsColumns.has("agentModels") ? "agentModels" : "'{}'"}, ${settingsColumns.has("density") ? "density" : "'default'"} FROM settings;
          DROP TABLE settings;
          ALTER TABLE settings_new RENAME TO settings;
          COMMIT;`);
      }
    }
    const migratedSettings = new Set((this.db.prepare("PRAGMA table_info(settings)").all() as { name: string }[]).map(column => column.name));
    if (!migratedSettings.has("notifyOnReview")) this.db.exec("ALTER TABLE settings ADD COLUMN notifyOnReview INTEGER NOT NULL DEFAULT 0 CHECK(notifyOnReview IN (0, 1))");
    if (!migratedSettings.has("agentModels")) this.db.exec("ALTER TABLE settings ADD COLUMN agentModels TEXT NOT NULL DEFAULT '{}'");
    if (!migratedSettings.has("showCardModels")) this.db.exec("ALTER TABLE settings ADD COLUMN showCardModels INTEGER NOT NULL DEFAULT 0 CHECK(showCardModels IN (0, 1))");
    if (!migratedSettings.has("density")) this.db.exec("ALTER TABLE settings ADD COLUMN density TEXT NOT NULL DEFAULT 'default' CHECK(density IN ('compact', 'default', 'cozy'))");
    const boardColumns = new Set((this.db.prepare("PRAGMA table_info(boards)").all() as { name: string }[]).map(column => column.name));
    if (!boardColumns.has("pushMainAfterMerge")) this.db.exec("ALTER TABLE boards ADD COLUMN pushMainAfterMerge INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("archived")) this.db.exec("ALTER TABLE boards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("icon")) this.db.exec("ALTER TABLE boards ADD COLUMN icon TEXT NOT NULL DEFAULT 'sprinkle_donut'");
    if (!boardColumns.has("color")) this.db.exec("ALTER TABLE boards ADD COLUMN color TEXT NOT NULL DEFAULT 'violet'");
    if (!boardColumns.has("remoteUrl")) this.db.exec("ALTER TABLE boards ADD COLUMN remoteUrl TEXT NOT NULL DEFAULT ''");
    if (!boardColumns.has("autoCollapseEmptySwimlanes")) this.db.exec("ALTER TABLE boards ADD COLUMN autoCollapseEmptySwimlanes INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("autoReviewEnabled")) this.db.exec("ALTER TABLE boards ADD COLUMN autoReviewEnabled INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("verificationCommand")) this.db.exec("ALTER TABLE boards ADD COLUMN verificationCommand TEXT NOT NULL DEFAULT ''");
    if (!boardColumns.has("autoReviewEnabledAt")) this.db.exec("ALTER TABLE boards ADD COLUMN autoReviewEnabledAt TEXT");
    if (!boardColumns.has("autoPickupEnabled")) this.db.exec("ALTER TABLE boards ADD COLUMN autoPickupEnabled INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("pickupConcurrency")) this.db.exec("ALTER TABLE boards ADD COLUMN pickupConcurrency INTEGER NOT NULL DEFAULT 2");
    if (!boardColumns.has("autoReviewMergeLimit")) this.db.exec("ALTER TABLE boards ADD COLUMN autoReviewMergeLimit INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("pickupDailyLimit")) this.db.exec("ALTER TABLE boards ADD COLUMN pickupDailyLimit INTEGER NOT NULL DEFAULT 6");
    if (!boardColumns.has("autoPickupResetRunRowid")) this.db.exec("ALTER TABLE boards ADD COLUMN autoPickupResetRunRowid INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("autoPickupEnabledAt")) this.db.exec("ALTER TABLE boards ADD COLUMN autoPickupEnabledAt TEXT");
    if (!boardColumns.has("autoPickupError")) this.db.exec("ALTER TABLE boards ADD COLUMN autoPickupError TEXT NOT NULL DEFAULT ''");
    if (!boardColumns.has("pickupCostBudget")) this.db.exec("ALTER TABLE boards ADD COLUMN pickupCostBudget REAL");
    if (!boardColumns.has("autoPickupResumeOnResolution")) {
      this.db.exec("ALTER TABLE boards ADD COLUMN autoPickupResumeOnResolution INTEGER NOT NULL DEFAULT 0");
      // Older failure pauses lost their enablement timestamp; recognize only this exact legacy reason.
      this.db.prepare("UPDATE boards SET autoPickupResumeOnResolution=1 WHERE autoPickupEnabled=0 AND autoPickupError=?")
        .run("An automatic run failed; inspect it before re-enabling pickup");
    }
    if (!boardColumns.has("agentModels")) this.db.exec("ALTER TABLE boards ADD COLUMN agentModels TEXT NOT NULL DEFAULT '{}'");
    if (!boardColumns.has("integration")) this.db.exec("ALTER TABLE boards ADD COLUMN integration TEXT NOT NULL DEFAULT 'local' CHECK(integration IN ('local', 'github-pr'))");
    if (!boardColumns.has("integrationError")) this.db.exec("ALTER TABLE boards ADD COLUMN integrationError TEXT NOT NULL DEFAULT ''");
    // integrationWarning: a sync problem Bakery is riding out (a failed fetch it retries). integrationSyncedAt: last full sync.
    if (!boardColumns.has("integrationWarning")) this.db.exec("ALTER TABLE boards ADD COLUMN integrationWarning TEXT NOT NULL DEFAULT ''");
    if (!boardColumns.has("integrationSyncedAt")) this.db.exec("ALTER TABLE boards ADD COLUMN integrationSyncedAt TEXT");
    // integrationChosen: the operator picked the mode, so detection never changes it. githubMainProtected: NULL until checked.
    if (!boardColumns.has("integrationChosen")) this.db.exec("ALTER TABLE boards ADD COLUMN integrationChosen INTEGER NOT NULL DEFAULT 0");
    if (!boardColumns.has("githubMainProtected")) this.db.exec("ALTER TABLE boards ADD COLUMN githubMainProtected INTEGER");
    if (!boardColumns.has("integrationNote")) this.db.exec("ALTER TABLE boards ADD COLUMN integrationNote TEXT NOT NULL DEFAULT ''");

    const runColumns = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map(column => column.name));
    if (!runColumns.has("turns")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN turns INTEGER NOT NULL DEFAULT 0");
      // Older transcripts lack event counts. Their highest visible activity marker is only an estimate.
      const update = this.db.prepare("UPDATE runs SET turns=? WHERE id=?");
      for (const row of this.db.prepare("SELECT id, output FROM runs").all() as { id: string; output: string }[]) {
        let count = 0;
        for (const match of row.output.matchAll(/(?:^|\n)Turn (\d+):/g)) count = Math.max(count, Number(match[1]));
        update.run(count, row.id);
      }
    }
    if (!runColumns.has("turnsIncomplete")) this.db.exec("ALTER TABLE runs ADD COLUMN turnsIncomplete INTEGER NOT NULL DEFAULT 1");
    if (!runColumns.has("startedBy")) this.db.exec("ALTER TABLE runs ADD COLUMN startedBy TEXT NOT NULL DEFAULT 'manual'");
    // Older runs did not record their agent; they keep an empty label rather than a guess.
    if (!runColumns.has("agent")) this.db.exec("ALTER TABLE runs ADD COLUMN agent TEXT NOT NULL DEFAULT ''");
    if (!runColumns.has("lastActivityAt")) this.db.exec("ALTER TABLE runs ADD COLUMN lastActivityAt TEXT");
    // 1 when the run was handed a PR's CI failures; its result is pushed to the PR without a manual Approve.
    if (!runColumns.has("ciFix")) this.db.exec("ALTER TABLE runs ADD COLUMN ciFix INTEGER NOT NULL DEFAULT 0");
    // The agent's final message, kept apart from the transcript so the card can show it as markdown.
    if (!runColumns.has("report")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN report TEXT");
      const update = this.db.prepare("UPDATE runs SET report=? WHERE id=?");
      for (const row of this.db.prepare("SELECT id, output FROM runs WHERE status!='running'").all() as { id: string; output: string }[])
        update.run(reportFromOutput(row.output), row.id);
    }
    const jobColumns = new Set((this.db.prepare("PRAGMA table_info(auto_review_jobs)").all() as { name: string }[]).map(column => column.name));
    if (!jobColumns.has("agent")) this.db.exec("ALTER TABLE auto_review_jobs ADD COLUMN agent TEXT NOT NULL DEFAULT ''");
    if (!jobColumns.has("interruptions")) this.db.exec("ALTER TABLE auto_review_jobs ADD COLUMN interruptions INTEGER NOT NULL DEFAULT 0");
    if (!jobColumns.has("changes")) this.db.exec("ALTER TABLE auto_review_jobs ADD COLUMN changes TEXT NOT NULL DEFAULT ''");
    if (!jobColumns.has("requeued")) this.db.exec("ALTER TABLE auto_review_jobs ADD COLUMN requeued INTEGER NOT NULL DEFAULT 0");
    // Older attempts and reviews keep NULL usage so the UI shows "—" rather than an invented 0.
    for (const [table, columns] of [["runs", runColumns], ["auto_review_jobs", jobColumns]] as const)
      for (const definition of usageDefinitions.split(", "))
        if (!columns.has(definition.split(" ")[0])) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    const approvalColumns = new Set((this.db.prepare("PRAGMA table_info(approvals)").all() as { name: string }[]).map(column => column.name));
    if (!approvalColumns.has("preparedHead")) this.db.exec("ALTER TABLE approvals ADD COLUMN preparedHead TEXT");
    if (!approvalColumns.has("merged")) this.db.exec("ALTER TABLE approvals ADD COLUMN merged INTEGER NOT NULL DEFAULT 0");
    // Preserve old cards and runs. A stored repository path is never reinterpreted against today's cwd.
    for (const row of this.db.prepare("SELECT DISTINCT repo FROM cards WHERE repo NOT IN (SELECT repo FROM boards)").all() as { repo: string }[]) this.addRepo(row.repo);
  }
  recoverInterruptedRuns(): void {
    // Only the server calls this under the exclusive data-directory lock.
    this.db.exec(`UPDATE runs SET status='interrupted', error='Server restarted while this run was active', finishedAt=datetime('now') WHERE status='running';
      UPDATE cards SET status='interrupted' WHERE status='running';
      UPDATE card_events SET reason='The server restarted while Pi was running' WHERE toStatus='interrupted' AND reason='';`);
  }
  recoverAutoReviews(): void {
    // Only the server may call this, after obtaining its exclusive data-directory lock.
    // A review cut off by a restart goes back in the queue once. A second interruption is left for a person, so a
    // review that keeps taking the server down cannot loop.
    this.db.prepare(`UPDATE auto_review_jobs SET state='needs_human', finishedAt=?, interruptions=interruptions+1,
      requeued=CASE WHEN interruptions=0 THEN 1 ELSE 0 END,
      details=CASE WHEN interruptions=0 THEN 'Server restarted during agent review; it will be reviewed again'
        ELSE 'Server restarted during agent review twice; inspect manually' END WHERE state='running'`).run(now());
  }
  /** Remember a run start asked for during a restart drain; the next server process replays it. */
  queueStart(cardId: string) {
    const card = this.getCard(cardId);
    if (!card) throw new Error("Card not found");
    if (card.status === "triage") throw new Error("Move this card to Ready before starting a run");
    this.db.prepare("INSERT OR IGNORE INTO queued_starts(cardId, queuedAt) VALUES (?, ?)").run(cardId, now());
  }
  /** Drops a start queued during a restart drain. Returns whether one was queued. */
  cancelQueuedStart(cardId: string): boolean { return this.db.prepare("DELETE FROM queued_starts WHERE cardId=?").run(cardId).changes > 0; }
  isStartQueued(cardId: string): boolean { return !!this.db.prepare("SELECT 1 FROM queued_starts WHERE cardId=?").get(cardId); }
  /** Returns queued card ids oldest first and empties the queue. */
  takeQueuedStarts(): string[] {
    const ids = (this.db.prepare("SELECT cardId FROM queued_starts ORDER BY queuedAt, rowid").all() as { cardId: string }[]).map(row => row.cardId);
    this.db.exec("DELETE FROM queued_starts");
    return ids;
  }
  close() { this.db.close(); }
  getSettings(): BakerySettings {
    const row = this.db.prepare("SELECT confirmRunStart, notifyOnReview, cardDetailsLayout, theme, density, showCardModels, agentModels FROM settings WHERE id=1").get() as { confirmRunStart: number; notifyOnReview: number; cardDetailsLayout: BakerySettings["cardDetailsLayout"]; theme: BakerySettings["theme"]; density: BakerySettings["density"]; showCardModels: number; agentModels: string };
    return { confirmRunStart: row.confirmRunStart === 1, notifyOnReview: row.notifyOnReview === 1, cardDetailsLayout: row.cardDetailsLayout, theme: row.theme, density: row.density, showCardModels: row.showCardModels === 1, agentModels: parseAgentModels(row.agentModels) };
  }
  updateSettings(settings: Partial<BakerySettings>): BakerySettings {
    const current = this.getSettings();
    const agentModels = settings.agentModels ? validateAgentModels(settings.agentModels) : current.agentModels;
    this.db.prepare("UPDATE settings SET confirmRunStart=?, notifyOnReview=?, cardDetailsLayout=?, theme=?, density=?, showCardModels=?, agentModels=? WHERE id=1").run((settings.confirmRunStart ?? current.confirmRunStart) ? 1 : 0, (settings.notifyOnReview ?? current.notifyOnReview) ? 1 : 0, settings.cardDetailsLayout ?? current.cardDetailsLayout, settings.theme ?? current.theme, settings.density ?? current.density, (settings.showCardModels ?? current.showCardModels) ? 1 : 0, JSON.stringify(agentModels));
    return this.getSettings();
  }
  listRepos(): string[] { return this.listBoards().map(board => board.repo); }
  private toBoard(row: BoardRow): RepoBoard {
    const starts = (this.db.prepare(`SELECT runs.startedAt FROM runs JOIN cards ON cards.id=runs.cardId
      WHERE cards.repo=? AND runs.startedBy='auto' AND runs.rowid>?
        AND julianday(runs.startedAt)>=julianday('now','-1 day') ORDER BY runs.startedAt`).all(row.repo, row.autoPickupResetRunRowid) as { startedAt: string }[]).map(run => run.startedAt);
    return toRepoBoard(row, starts, this.cost24h(row.repo), this.autoReviewMergesToday(row.repo));
  }
  // Rolling 24h spend: attempts and agent reviews still running or finished within the last day.
  // Cost accrues while a run is active, so a long run counts until a day after it ends.
  private cost24h(repo: string): number {
    const spend = (table: "runs" | "auto_review_jobs") => `SELECT ${table}.cost FROM ${table} JOIN cards ON cards.id=${table}.cardId
      WHERE cards.repo=? AND ${table}.cost IS NOT NULL AND (${table}.finishedAt IS NULL OR julianday(${table}.finishedAt)>=julianday('now','-1 day'))`;
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost), 0) AS total FROM (${spend("runs")} UNION ALL ${spend("auto_review_jobs")})`).get(repo, repo) as { total: number };
    return row.total;
  }
  listBoards(): RepoBoard[] { return (this.db.prepare(`SELECT ${boardFields} FROM boards WHERE archived=0 ORDER BY repo`).all() as BoardRow[]).map(row => this.toBoard(row)); }
  getBoard(id: string): RepoBoard | undefined {
    const row = this.db.prepare(`SELECT ${boardFields} FROM boards WHERE id=? AND archived=0`).get(id) as BoardRow | undefined;
    return row && this.toBoard(row);
  }
  addRepo(repo: string): RepoBoard {
    const existing = this.db.prepare("SELECT id FROM boards WHERE repo=?").get(repo) as { id: string } | undefined;
    if (existing) {
      this.db.prepare("UPDATE boards SET archived=0 WHERE id=?").run(existing.id);
      return this.getBoard(existing.id)!;
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO boards(id, repo) VALUES (?, ?)").run(id, repo);
    return this.getBoard(id)!;
  }
  setAppearance(id: string, icon: string, color: string): RepoBoard {
    if (!this.getBoard(id)) throw new Error("Board not found");
    if (!repoIcons.some(value => value === icon) || !Object.hasOwn(repoColors, color)) throw new Error("Invalid repository icon or color");
    this.db.prepare("UPDATE boards SET icon=?, color=? WHERE id=?").run(icon, color, id);
    return this.getBoard(id)!;
  }
  setRemoteUrl(id: string, remoteUrl: string): RepoBoard {
    if (!this.getBoard(id)) throw new Error("Board not found");
    const value = remoteUrl.trim();
    if (value) {
      let url: URL | undefined;
      try { url = new URL(value); } catch { /* Reported below. */ }
      if (value.length > 500 || !url || (url.protocol !== "https:" && url.protocol !== "http:"))
        throw new Error("Remote repository link must be an http:// or https:// URL (maximum 500 characters)");
    }
    if (this.getBoard(id)!.integration === "github-pr" && !githubRepo(value)) throw new Error("This board integrates through GitHub pull requests; its remote must stay a https://github.com/OWNER/REPO link");
    // A new remote is a new repository: what was detected about the old one no longer applies.
    if (value !== this.getBoard(id)!.remoteUrl) this.db.prepare("UPDATE boards SET remoteUrl=?, githubMainProtected=NULL, integrationNote='' WHERE id=?").run(value, id);
    return this.getBoard(id)!;
  }
  /** github-pr needs a GitHub remote so Bakery knows which repository `gh` should query. */
  setIntegration(id: string, mode: unknown): RepoBoard {
    const board = this.getBoard(id);
    if (!board) throw new Error("Board not found");
    if (mode !== "local" && mode !== "github-pr") throw new Error("Integration must be local or github-pr");
    if (mode === "github-pr" && !githubRepo(board.remoteUrl)) throw new Error("github-pr integration requires the board's remote to be a GitHub repository link (https://github.com/OWNER/REPO)");
    this.db.prepare("UPDATE boards SET integration=?, integrationError='', integrationWarning='', integrationChosen=1 WHERE id=?").run(mode, id);
    return this.getBoard(id)!;
  }
  /**
   * Records whether GitHub main for `remoteUrl` only accepts pull requests (null: could not tell, with `note` saying
   * why). With `switchMode`, a protected main switches the board to github-pr unless the operator chose the mode.
   * Nothing is written when the board's remote has changed since the check started.
   */
  recordGithubProtection(id: string, remoteUrl: string, isProtected: boolean | null, note: string, switchMode: boolean): RepoBoard | undefined {
    const board = this.getBoard(id);
    if (!board || board.remoteUrl !== remoteUrl) return board;
    const switchToPr = switchMode && isProtected === true && !board.integrationChosen && board.integration === "local";
    this.db.prepare("UPDATE boards SET githubMainProtected=?, integrationNote=?, integration=? WHERE id=?")
      .run(isProtected === null ? null : isProtected ? 1 : 0, note.slice(0, 2000), switchToPr ? "github-pr" : board.integration, id);
    return this.getBoard(id);
  }
  /** An integration error pauses automatic pickup on the board until a later sync clears it. */
  setIntegrationError(id: string, error: string): void {
    this.db.prepare("UPDATE boards SET integrationError=?, integrationWarning='' WHERE id=?").run(error.slice(0, 2000), id);
  }
  /** A sync problem that does not pause pickup yet: Bakery retries, and escalates to an error if it lasts. */
  setIntegrationWarning(id: string, warning: string): void {
    this.db.prepare("UPDATE boards SET integrationWarning=? WHERE id=?").run(warning.slice(0, 2000), id);
  }
  /** A sync pass finished: clears any error or warning and records when. */
  recordIntegrationSync(id: string, at = new Date().toISOString()): void {
    this.db.prepare("UPDATE boards SET integrationError='', integrationWarning='', integrationSyncedAt=? WHERE id=?").run(at, id);
  }
  boardForRepo(repo: string): RepoBoard | undefined { return this.listBoards().find(item => item.repo === repo); }
  integrationFor(repo: string): IntegrationMode {
    return (this.db.prepare("SELECT integration FROM boards WHERE repo=?").get(repo) as { integration: IntegrationMode } | undefined)?.integration ?? "local";
  }
  /** A PR URL that overrides the `bakery/<id>` branch lookup; an empty value restores the lookup. */
  setPullRequestOverride(cardId: string, url: string): Card {
    const card = this.getCard(cardId);
    if (!card) throw new Error("Card not found");
    if (card.status === "done" || card.status === "archived") throw new Error("This card is already Done");
    const value = url.trim();
    if (value && !parsePullRequestUrl(value)) throw new Error("Pull request link must look like https://github.com/OWNER/REPO/pull/NUMBER");
    const board = this.boardForRepo(card.repo), pr = value ? parsePullRequestUrl(value)! : undefined, repo = board && githubRepo(board.remoteUrl);
    if (pr && repo && pr.repo.toLowerCase() !== repo.toLowerCase()) throw new Error(`Pull request is in ${pr.repo}, but this board's remote is ${repo}`);
    this.db.prepare("UPDATE cards SET prOverrideUrl=?, prNumber=?, prUrl=?, prState=NULL, prChecks=NULL, prError=NULL, updatedAt=? WHERE id=?")
      .run(value || null, pr?.number ?? null, value || null, now(), cardId);
    return this.getCard(cardId)!;
  }
  recordPullRequest(cardId: string, pr: { number: number; url: string; state: "OPEN" | "CLOSED" | "MERGED"; checks?: string | null; error?: string | null; ciPending?: boolean }): void {
    this.db.prepare("UPDATE cards SET prNumber=?, prUrl=?, prState=?, prChecks=?, prError=?, prCiPending=? WHERE id=?")
      .run(pr.number, pr.url, pr.state, pr.checks ?? null, pr.error ?? null, pr.ciPending ? 1 : 0, cardId);
  }
  /** Approve pushed `runId`'s work to the card's PR. */
  recordPullRequestPush(cardId: string, runId: string): void {
    this.db.prepare("UPDATE cards SET prPushedRunId=? WHERE id=?").run(runId, cardId);
  }
  recordPullRequestError(cardId: string, error: string): void {
    this.db.prepare("UPDATE cards SET prError=? WHERE id=?").run(error.slice(0, 4000), cardId);
  }
  /**
   * The PR's checks failed at `headSha`: count a CI rework round and keep the failures for the next run.
   * Each head commit is sent back at most once.
   */
  recordCiFailure(cardId: string, headSha: string, failures: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE cards SET ciReworks=ciReworks+1, ciReworkSha=? WHERE id=?").run(headSha, cardId);
      this.db.prepare("INSERT INTO ci_feedback(cardId, headSha, failures, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT(cardId) DO UPDATE SET headSha=excluded.headSha, failures=excluded.failures, createdAt=excluded.createdAt")
        .run(cardId, headSha, failures.slice(0, 20_000), now());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /**
   * A pre-push hook refused the push of `sha`: keep its output for the card's next run. Unlike CI rounds this is not
   * counted or limited, because each round starts from an operator's Approve, and the fix waits for another one.
   */
  recordPushFailure(cardId: string, sha: string, output: string): void {
    this.db.prepare("INSERT INTO ci_feedback(cardId, headSha, failures, createdAt, source) VALUES (?, ?, ?, ?, 'push') ON CONFLICT(cardId) DO UPDATE SET headSha=excluded.headSha, failures=excluded.failures, createdAt=excluded.createdAt, source='push'")
      .run(cardId, sha, output.slice(-20_000), now());
  }
  /**
   * The PR conflicts with main and the conflict is small enough to repair unattended: count a repair round, keep the
   * conflict for the next run, and remember `key` (PR head and main tip) so the same conflict is sent back once.
   */
  recordConflictRepair(cardId: string, key: string, headSha: string, files: string[], details: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE cards SET conflictRepairs=conflictRepairs+1, conflictRepairKey=? WHERE id=?").run(key, cardId);
      this.recordMergeFailure(cardId, files, details);
      this.db.prepare("INSERT INTO ci_feedback(cardId, headSha, failures, createdAt, source) VALUES (?, ?, ?, ?, 'conflict') ON CONFLICT(cardId) DO UPDATE SET headSha=excluded.headSha, failures=excluded.failures, createdAt=excluded.createdAt, source='conflict'")
        .run(cardId, headSha, details.slice(0, 20_000), now());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Marks a conflict as seen without repairing it (too big, or out of rounds). */
  markConflictHandled(cardId: string, key: string): void {
    this.db.prepare("UPDATE cards SET conflictRepairKey=? WHERE id=?").run(key, cardId);
  }
  /** Marks `headSha` as handled without sending the card back, e.g. once the rework limit is reached. */
  markCiHandled(cardId: string, headSha: string): void {
    this.db.prepare("UPDATE cards SET ciReworkSha=? WHERE id=?").run(headSha, cardId);
  }
  /** CI failures waiting for the card's next run. */
  getCiFeedback(cardId: string): { headSha: string; failures: string; source: "ci" | "push" | "conflict" } | undefined {
    return this.db.prepare("SELECT headSha, failures, source FROM ci_feedback WHERE cardId=?").get(cardId) as { headSha: string; failures: string; source: "ci" | "push" | "conflict" } | undefined;
  }
  /**
   * The waiting failures went stale before a fix run took them (CI is re-running or passed). The round never ran,
   * so it is not counted, and the head commit can be sent back again if it fails again.
   */
  dropCiFeedback(cardId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("DELETE FROM ci_feedback WHERE cardId=? AND source='ci'").run(cardId).changes)
        this.db.prepare("UPDATE cards SET ciReworks=MAX(ciReworks-1, 0), ciReworkSha=NULL WHERE id=?").run(cardId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Hands a run the waiting failures. A CI fix run is also marked, so its result is pushed without Approve; a hook fix waits for Approve. */
  startCiFix(cardId: string, runId: string, source: "ci" | "push" | "conflict" = "ci"): void {
    // ciFix is 1 for a CI fix and 2 for a conflict repair; both are pushed without Approve.
    if (source !== "push") this.db.prepare("UPDATE runs SET ciFix=? WHERE id=?").run(source === "conflict" ? 2 : 1, runId);
    this.clearCiFeedback(cardId);
  }
  /** Review cards whose refused push is waiting for a run slot to go back to the agent (see `Worker.startHookFix`). */
  listWaitingHookFixes(): Card[] {
    const ids = (this.db.prepare("SELECT cardId FROM ci_feedback WHERE source='push' ORDER BY createdAt").all() as { cardId: string }[]).map(row => row.cardId);
    return ids.map(id => this.getCard(id)).filter((card): card is Card => card?.status === "review");
  }
  clearCiFeedback(cardId: string): void { this.db.prepare("DELETE FROM ci_feedback WHERE cardId=?").run(cardId); }
  /** Review cards on a github-pr board, which the PR poller links and checks. */
  listPullRequestCards(repo: string): Card[] { return this.listCards(repo).filter(card => card.status === "review" && card.attempts > 0); }
  /** The PR merged and its merge commit is on origin/main: the card is Done. */
  recordPullRequestMerge(cardId: string, candidate: string, mergeCommit: string): Card {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId), run = this.listRuns(cardId)[0];
      if (card?.status !== "review" || !run || this.wasIntegrated(cardId)) throw new Error("Card changed during pull request reconciliation");
      this.db.prepare("INSERT INTO external_integrations(cardId, runId, candidate, mergeCommit, integratedAt) VALUES (?, ?, ?, ?, ?)")
        .run(cardId, run.id, candidate, mergeCommit, now());
      this.db.prepare("UPDATE cards SET status='done', prState='MERGED', prError=NULL, updatedAt=? WHERE id=?").run(now(), cardId);
      this.explain(cardId, `Pull request #${card.prNumber ?? "?"} merged; ${mergeCommit.slice(0, 7)} is on origin/main`);
      this.clearMergeFailure(cardId);
      this.db.exec("COMMIT");
      return this.getCard(cardId)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Done cards on this board that Bakery merged into local main (`approvals.merged=1`), with the approved candidate. */
  listLocalMerges(repo: string): { card: Card; candidate: string }[] {
    const rows = this.db.prepare(`SELECT approvals.cardId, approvals.candidate FROM approvals JOIN cards ON cards.id=approvals.cardId
      WHERE cards.repo=? AND cards.status='done' AND approvals.merged=1
        AND NOT EXISTS (SELECT 1 FROM external_integrations WHERE external_integrations.cardId=cards.id)
      ORDER BY cards.updatedAt, cards.rowid`).all(repo) as { cardId: string; candidate: string }[];
    return rows.map(row => ({ card: this.getCard(row.cardId)!, candidate: row.candidate }));
  }
  /**
   * A locally merged card was published as a pull request: drop the local integration record and move it back to
   * Review, linked to the PR, so the PR poller takes it to Done once the PR merges.
   */
  recordPublishedLocalMerge(cardId: string, candidate: string, pr: { number: number; url: string }): Card {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId);
      const approval = this.db.prepare("SELECT candidate, runId FROM approvals WHERE cardId=? AND merged=1").get(cardId) as { candidate: string; runId: string } | undefined;
      if (card?.status !== "done" || approval?.candidate !== candidate) throw new Error("Card changed while publishing; reload it and retry");
      this.db.prepare("DELETE FROM approvals WHERE cardId=?").run(cardId);
      this.db.prepare("UPDATE cards SET status='review', prNumber=?, prUrl=?, prState='OPEN', prChecks=NULL, prError=NULL, prCiPending=0, prPushedRunId=?, updatedAt=? WHERE id=?")
        .run(pr.number, pr.url, approval.runId, now(), cardId);
      this.explain(cardId, `Local merge published as pull request #${pr.number}; Done again once it merges`);
      this.clearMergeFailure(cardId);
      this.db.exec("COMMIT");
      return this.getCard(cardId)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** A PR closed without merging needs the operator: the card fails with the reason. */
  closePullRequestUnmerged(cardId: string, reason: string): Card {
    const result = this.db.prepare("UPDATE cards SET status='failed', prState='CLOSED', prError=?, updatedAt=? WHERE id=? AND status='review'").run(reason, now(), cardId);
    if (result.changes) this.explain(cardId, `Pull request closed without merging: ${reason}`);
    return this.getCard(cardId)!;
  }
  setAgentModels(id: string, agentModels: unknown): RepoBoard {
    if (!this.getBoard(id)) throw new Error("Board not found");
    this.db.prepare("UPDATE boards SET agentModels=? WHERE id=?").run(JSON.stringify(validateAgentModels(agentModels)), id);
    return this.getBoard(id)!;
  }
  /** Repository choice per field, then the global default; empty fields leave Pi's own default. */
  agentModelFor(repo: string, phase: AgentPhase): AgentModel {
    const row = this.db.prepare("SELECT agentModels FROM boards WHERE repo=?").get(repo) as { agentModels: string } | undefined;
    return resolveAgentModel(phase, row && parseAgentModels(row.agentModels), this.getSettings().agentModels);
  }
  setAutoCollapseEmptySwimlanes(id: string, enabled: boolean): RepoBoard {
    if (!this.getBoard(id)) throw new Error("Board not found");
    this.db.prepare("UPDATE boards SET autoCollapseEmptySwimlanes=? WHERE id=?").run(enabled ? 1 : 0, id);
    return this.getBoard(id)!;
  }
  /** Local-merge boards only: after Bakery merges a card into local main it pushes main to origin. Off by default. */
  setPushMainAfterMerge(id: string, enabled: boolean): RepoBoard {
    if (!this.getBoard(id)) throw new Error("Board not found");
    this.db.prepare("UPDATE boards SET pushMainAfterMerge=? WHERE id=?").run(enabled ? 1 : 0, id);
    return this.getBoard(id)!;
  }
  setAutoReview(id: string, enabled: boolean, verificationCommand: string): RepoBoard {
    const board = this.getBoard(id);
    if (!board) throw new Error("Board not found");
    const command = verificationCommand.trim();
    if (command.length > 500 || (enabled && !command)) throw new Error("Auto-review requires a verification command (maximum 500 characters)");
    this.db.prepare("UPDATE boards SET autoReviewEnabled=?, verificationCommand=?, autoReviewEnabledAt=? WHERE id=?")
      .run(enabled ? 1 : 0, command, enabled ? (board.autoReviewEnabled && board.verificationCommand === command ? board.autoReviewEnabledAt : now()) : null, id);
    return this.getBoard(id)!;
  }
  /** The most unattended merges this board allows in a rolling 24 hours; 0 means no limit. */
  setAutoReviewMergeLimit(id: string, limit: number): RepoBoard {
    if (!this.getBoard(id)) throw new Error("Board not found");
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 99) throw new Error("Auto-review merge limit must be 0 (no limit) or between 1 and 99");
    this.db.prepare("UPDATE boards SET autoReviewMergeLimit=? WHERE id=?").run(limit, id);
    return this.getBoard(id)!;
  }
  /** Whether the board's rolling 24-hour limit on unattended merges is used up. */
  autoReviewMergeLimitReached(repoBoard: RepoBoard): boolean {
    return repoBoard.autoReviewMergeLimit > 0 && this.autoReviewMergesToday(repoBoard.repo) >= repoBoard.autoReviewMergeLimit;
  }
  setAutoPickup(id: string, enabled: boolean, concurrency: number, dailyLimit?: number, costBudget?: number | null): RepoBoard {
    const current = this.getBoard(id);
    if (!current) throw new Error("Board not found");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Auto-pickup concurrency must be between 1 and 4");
    const limit = dailyLimit ?? current.pickupDailyLimit;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 99) throw new Error("Auto-pickup daily start limit must be 0 (no limit) or between 1 and 99");
    const budget = costBudget === undefined ? current.pickupCostBudget : costBudget;
    if (budget !== null && (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0.01 || budget > 10_000))
      throw new Error("Auto-pickup daily cost budget must be off or between $0.01 and $10,000");
    this.db.prepare("UPDATE boards SET autoPickupEnabled=?, pickupConcurrency=?, pickupDailyLimit=?, pickupCostBudget=?, autoPickupEnabledAt=?, autoPickupError='', autoPickupResumeOnResolution=0 WHERE id=?")
      .run(enabled ? 1 : 0, concurrency, limit, budget === null ? null : Math.round(budget * 100) / 100, enabled ? (current.autoPickupEnabled ? current.autoPickupEnabledAt : now()) : null, id);
    return this.getBoard(id)!;
  }
  resetAutoPickupLimit(id: string): RepoBoard {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const board = this.getBoard(id);
      if (!board) throw new Error("Board not found");
      if (!board.autoPickupEnabled || board.pickupDailyLimit === 0 || board.autoPickupStarts < board.pickupDailyLimit) throw new Error("Auto-pickup start limit is not currently reached on this enabled board");
      // A rowid boundary counts a claim even when it shares the reset's millisecond.
      const last = (this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS id FROM runs").get() as { id: number }).id;
      this.db.prepare("UPDATE boards SET autoPickupResetRunRowid=? WHERE id=?").run(last, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getBoard(id)!;
  }
  pauseAutoPickup(id: string, reason: string, resumeOnResolution = false): void {
    this.db.prepare("UPDATE boards SET autoPickupEnabled=0, autoPickupEnabledAt=CASE WHEN ? THEN autoPickupEnabledAt ELSE NULL END, autoPickupError=?, autoPickupResumeOnResolution=? WHERE id=? AND autoPickupEnabled=1")
      .run(resumeOnResolution ? 1 : 0, reason.slice(0, 500), resumeOnResolution ? 1 : 0, id);
  }
  private hasUnresolvedAutoFailure(repo: string, since: string | null): boolean {
    return !!this.db.prepare(`SELECT 1 FROM runs JOIN cards ON cards.id=runs.cardId
      WHERE cards.repo=? AND runs.startedBy='auto' AND runs.status='failed' AND runs.startedAt>=?
        AND cards.status NOT IN ('done', 'archived')
        AND NOT EXISTS (SELECT 1 FROM approvals WHERE approvals.cardId=cards.id AND approvals.merged=1)
        AND NOT EXISTS (SELECT 1 FROM external_integrations WHERE external_integrations.cardId=cards.id)
      LIMIT 1`).get(repo, since ?? "");
  }
  resumeResolvedAutoPickup(): void {
    if (!this.db.prepare("SELECT 1 FROM boards WHERE archived=0 AND autoPickupEnabled=0 AND autoPickupResumeOnResolution=1 LIMIT 1").get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const paused = this.db.prepare("SELECT id, repo, autoPickupEnabledAt FROM boards WHERE archived=0 AND autoPickupEnabled=0 AND autoPickupResumeOnResolution=1")
        .all() as { id: string; repo: string; autoPickupEnabledAt: string | null }[];
      for (const board of paused) {
        if (this.db.prepare("SELECT 1 FROM cards WHERE repo=? AND status='interrupted' LIMIT 1").get(board.repo)) continue;
        if (this.hasUnresolvedAutoFailure(board.repo, board.autoPickupEnabledAt)) continue;
        this.db.prepare("UPDATE boards SET autoPickupEnabled=1, autoPickupEnabledAt=COALESCE(autoPickupEnabledAt, ?), autoPickupError='', autoPickupResumeOnResolution=0 WHERE id=?")
          .run(now(), board.id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  runningCount(repo: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE repo=? AND status='running'").get(repo) as { n: number }).n;
  }
  autoPickupBudgetReached(repo: string): boolean {
    return !!this.listBoards().find(item => item.repo === repo)?.autoPickupBudgetReached;
  }
  autoStartsToday(repo: string): number {
    const row = this.db.prepare(`SELECT ${boardFields} FROM boards WHERE repo=? AND archived=0`).get(repo) as BoardRow | undefined;
    return row ? this.toBoard(row).autoPickupStarts : 0;
  }
  listAutoPickupCandidates(): { card: Card; board: RepoBoard }[] {
    const result: { card: Card; board: RepoBoard }[] = [];
    for (const repoBoard of this.listBoards().filter(item => item.autoPickupEnabled)) {
      if (this.runningCount(repoBoard.repo) >= repoBoard.pickupConcurrency || (repoBoard.pickupDailyLimit > 0 && repoBoard.autoPickupStarts >= repoBoard.pickupDailyLimit) || repoBoard.autoPickupBudgetReached || repoBoard.integrationError) continue;
      const ids = this.db.prepare("SELECT id FROM cards WHERE repo=? AND status='ready' ORDER BY priority DESC, createdAt, rowid").all(repoBoard.repo) as { id: string }[];
      // A card waiting on dependencies is skipped, so it takes no concurrency slot or daily start.
      result.push(...ids.map(({ id }) => ({ card: this.getCard(id)!, board: repoBoard })).filter(item => !waitsOnDependencies(item.card)));
    }
    return result;
  }
  autoPickupBlocker(repoBoard: RepoBoard): { kind: "interrupted" | "failed_run"; reason: string } | undefined {
    if (this.db.prepare("SELECT 1 FROM cards WHERE repo=? AND status='interrupted' LIMIT 1").get(repoBoard.repo))
      return { kind: "interrupted", reason: "An interrupted run needs inspection before automatic pickup" };
    if (this.hasUnresolvedAutoFailure(repoBoard.repo, repoBoard.autoPickupEnabledAt))
      return { kind: "failed_run", reason: "An automatic run failed; inspect and integrate its card before pickup resumes" };
    return undefined;
  }
  listAutoReviewCandidates(): { card: Card; run: Run; board: RepoBoard }[] {
    const result: { card: Card; run: Run; board: RepoBoard }[] = [];
    // On a github-pr board the agent only reviews: AutoReview never merges there, and Approve still opens the PR.
    for (const repoBoard of this.listBoards().filter(item => item.autoReviewEnabled)) {
      for (const card of this.listCards(repoBoard.repo).filter(item => item.status === "review")) {
        const run = this.listRuns(card.id)[0];
        if (run && this.awaitsAutoReview(repoBoard, card.id, run)) result.push({ card, run, board: repoBoard });
      }
    }
    return result.sort((a, b) => a.run.finishedAt!.localeCompare(b.run.finishedAt!));
  }
  /** The run finished after auto-review was enabled and nothing (a person, an earlier job) has handled it yet. */
  private awaitsAutoReview(repoBoard: RepoBoard, cardId: string, run: Run): boolean {
    return repoBoard.autoReviewEnabled &&
      run.status === "review" && !!run.finishedAt && !!repoBoard.autoReviewEnabledAt && run.finishedAt > repoBoard.autoReviewEnabledAt &&
      !(this.getAutoReviewJob(run.id)?.requeued === 0) && !this.getApproval(cardId) && !this.getMergeFailure(cardId) &&
      !this.hasRequestedChanges(cardId, run.id) && !this.hasDraftReviewComments(cardId, run.id);
  }
  /** See `ReviewWait`. Anything this does not recognize as someone else's turn is the person's turn. */
  private reviewWait(card: Omit<Card, "reviewWait" | "startQueued">, repoBoard: RepoBoard | undefined): ReviewWait | null {
    if (card.status !== "review" || !repoBoard) return null;
    const run = this.listRuns(card.id)[0];
    if (run?.status !== "review") return null;
    if (repoBoard.integration === "github-pr") {
      // Before a pull request exists, an agent review in progress or queued is the agent's turn.
      if (!card.prState && (this.getAutoReviewJob(run.id)?.state === "running" || this.awaitsAutoReview(repoBoard, card.id, run))) return "agent_review";
      if (card.prState === "MERGED") return "github";
      // A run newer than the pushed one (a CI fix, a rerun) waits for Approve to push it.
      if (card.prState !== "OPEN" || (!card.prOverrideUrl && card.prPushedRunId !== run.id)) return null;
      if (this.getCiFeedback(card.id)?.source === "conflict") return "ci_fix";
      if (card.prChecks !== "failing") return "github";
      return card.prCiPending || this.getCiFeedback(card.id)?.source === "ci" ? "ci_fix" : null;
    }
    if (this.getAutoReviewJob(run.id)?.state === "running" || this.awaitsAutoReview(repoBoard, card.id, run)) return "agent_review";
    return null;
  }
  private toCards(rows: CardRow[]): Card[] {
    const boards = new Map(this.listBoards().map(item => [item.repo, item]));
    const queued = new Set((this.db.prepare("SELECT cardId FROM queued_starts").all() as { cardId: string }[]).map(item => item.cardId));
    return rows.map(row => {
      const card = { ...row, createdCardIds: row.createdCardIds === null ? null : JSON.parse(row.createdCardIds) as string[], dependsOn: JSON.parse(row.dependsOn) as string[], blocked: row.blocked !== 0, locallyMerged: row.locallyMerged !== 0, planOnly: row.planOnly !== 0 };
      return { ...card, reviewWait: this.reviewWait(card, boards.get(card.repo)), startQueued: queued.has(card.id) };
    });
  }
  autoReviewMergesToday(repo: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM auto_review_jobs JOIN cards ON cards.id=auto_review_jobs.cardId WHERE cards.repo=? AND state='merged' AND julianday(finishedAt)>=julianday('now','-1 day')")
      .get(repo) as { n: number }).n;
  }
  getAutoReviewJob(runId: string): AutoReviewJob | undefined {
    return this.db.prepare("SELECT * FROM auto_review_jobs WHERE runId=?").get(runId) as AutoReviewJob | undefined;
  }
  /** Every run, agent review and card, for the Statistics page to aggregate; see server/stats.ts. */
  statsInput(): StatsInput {
    return {
      runs: this.db.prepare("SELECT cards.repo AS repo, runs.cardId, runs.status, runs.startedBy, runs.agent, runs.ciFix, runs.startedAt, runs.finishedAt, runs.cost, runs.inputTokens, runs.outputTokens, runs.cacheReadTokens, runs.cacheWriteTokens FROM runs JOIN cards ON cards.id=runs.cardId WHERE runs.startedAt IS NOT NULL").all() as StatsInput["runs"],
      reviews: this.db.prepare("SELECT cards.repo AS repo, job.state, job.agent, job.startedAt, job.finishedAt, job.cost FROM auto_review_jobs job JOIN cards ON cards.id=job.cardId").all() as StatsInput["reviews"],
      cards: this.db.prepare("SELECT repo, status, createdAt, updatedAt, reviewRounds, ciReworks, attempts FROM (SELECT cards.*, (SELECT COUNT(*) FROM runs WHERE runs.cardId=cards.id) AS attempts, (SELECT COUNT(DISTINCT rc.runId) FROM review_comments rc WHERE rc.cardId=cards.id AND rc.state='requested') AS reviewRounds FROM cards)").all() as StatsInput["cards"],
    };
  }
  listAutoReviewJobs(cardId: string): AutoReviewJob[] {
    return this.db.prepare("SELECT * FROM auto_review_jobs WHERE cardId=? ORDER BY startedAt DESC").all(cardId) as AutoReviewJob[];
  }
  beginAutoReview(cardId: string, runId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.listAutoReviewCandidates().find(item => item.card.id === cardId && item.run.id === runId);
      if (!candidate) throw new Error("Auto-review is not eligible for this card");
      // A requeued job keeps its row, so the interrupted attempt's spend and agent still count.
      this.db.prepare(`INSERT INTO auto_review_jobs(cardId,runId,state,startedAt,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,cost) VALUES (?,?,'running',?,0,0,0,0,0)
        ON CONFLICT(runId) DO UPDATE SET state='running', details='', fingerprint='', startedAt=excluded.startedAt, finishedAt=NULL, requeued=0 WHERE requeued=1`).run(cardId, runId, now());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finishAutoReview(runId: string, state: "needs_human" | "merged", details: string, fingerprint = "", changes?: { path: string; line?: number; comment: string }[]): void {
    this.db.prepare("UPDATE auto_review_jobs SET state=?, details=?, fingerprint=?, finishedAt=?, changes=? WHERE runId=? AND state='running'")
      .run(state, details.slice(0, 4000), fingerprint, now(), changes ? JSON.stringify(changes) : "", runId);
  }
  /** What a running review is doing now; shown in the Reviews tab until it finishes. */
  setAutoReviewProgress(runId: string, details: string): void {
    this.db.prepare("UPDATE auto_review_jobs SET details=? WHERE runId=? AND state='running'").run(details, runId);
  }
  /** How many times the agent reviewer has sent this card back to its implementer. */
  reviewerSendBacks(cardId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM auto_review_jobs WHERE cardId=? AND changes<>''").get(cardId) as { n: number }).n;
  }
  /** Changes the agent reviewer requested on this run, if any. */
  getReviewerChanges(runId: string): { path: string; line?: number; comment: string }[] {
    const job = this.getAutoReviewJob(runId);
    return job?.changes ? JSON.parse(job.changes) : [];
  }
  recordAutoReviewAgent(runId: string, label: string): void {
    const job = this.getAutoReviewJob(runId);
    if (job) this.db.prepare("UPDATE auto_review_jobs SET agent=? WHERE runId=?").run(addAgent(job.agent, label), runId);
  }
  recordAutoReviewUsage(runId: string, usage: Usage): void {
    this.db.prepare(`UPDATE auto_review_jobs SET ${usageUpdate} WHERE runId=?`).run(...usageValues(usage), runId);
  }
  renameBoard(id: string, repo: string): RepoBoard {
    const board = this.getBoard(id);
    if (!board) throw new Error("Board not found");
    if (board.repo === repo) return board;
    if (this.db.prepare("SELECT id FROM boards WHERE repo=?").get(repo)) throw new Error("Repository already has a board");
    if (this.db.prepare("SELECT 1 FROM runs JOIN cards ON cards.id=runs.cardId WHERE cards.repo=? LIMIT 1").get(board.repo)) throw new Error("Cannot change repository after a card has an attempt");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE cards SET repo=?, updatedAt=? WHERE repo=?").run(repo, now(), board.repo);
      this.db.prepare("UPDATE boards SET repo=? WHERE id=?").run(repo, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getBoard(id)!;
  }
  archiveBoard(id: string) {
    const board = this.getBoard(id);
    if (!board) throw new Error("Board not found");
    if (this.db.prepare("SELECT 1 FROM cards WHERE repo=? AND status IN ('running', 'interrupted') LIMIT 1").get(board.repo)) throw new Error("Resolve running or interrupted cards before removing this board");
    this.db.prepare("UPDATE boards SET archived=1 WHERE id=?").run(id);
  }
  /** Cards per board and status. `review` counts only Review cards that need you; `reviewWaiting` counts the rest. */
  cardCounts(): Record<string, Partial<Record<CardStatus | "reviewWaiting", number>>> {
    const counts: Record<string, Partial<Record<CardStatus | "reviewWaiting", number>>> = {};
    for (const row of this.db.prepare("SELECT repo, status, COUNT(*) AS count FROM cards WHERE status != 'review' GROUP BY repo, status").all() as { repo: string; status: CardStatus; count: number }[])
      (counts[row.repo] ??= {})[row.status] = Number(row.count);
    const review = this.db.prepare(`${cardQuery} WHERE cards.status='review' GROUP BY cards.id`).all() as CardRow[];
    for (const card of this.toCards(review)) {
      const key = card.reviewWait ? "reviewWaiting" : "review", repo = (counts[card.repo] ??= {});
      repo[key] = (repo[key] ?? 0) + 1;
    }
    return counts;
  }
  listCards(repo?: string): Card[] { return this.toCards((repo === undefined
    ? this.db.prepare(`${cardQuery} GROUP BY cards.id ORDER BY cards.priority DESC, cards.createdAt DESC, cards.rowid DESC`).all()
    : this.db.prepare(`${cardQuery} WHERE cards.repo=? GROUP BY cards.id ORDER BY cards.priority DESC, cards.createdAt DESC, cards.rowid DESC`).all(repo)) as CardRow[]); }
  /** The commit that put each integrated card on local main: Bakery's merge, or the merge found by reconciliation. */
  listMergeCommits(repo: string): Map<string, string> {
    const rows = this.db.prepare(`SELECT cards.id AS cardId, COALESCE(a.preparedHead, e.mergeCommit) AS mergeCommit FROM cards
      LEFT JOIN approvals a ON a.cardId=cards.id AND a.merged=1 LEFT JOIN external_integrations e ON e.cardId=cards.id
      WHERE cards.repo=? AND COALESCE(a.preparedHead, e.mergeCommit) IS NOT NULL`).all(repo) as { cardId: string; mergeCommit: string }[];
    return new Map(rows.map(row => [row.cardId, row.mergeCommit]));
  }
  getCard(id: string): Card | undefined {
    const row = this.db.prepare(`${cardQuery} WHERE cards.id=? GROUP BY cards.id`).get(id) as CardRow | undefined;
    return row && this.toCards([row])[0];
  }
  /** The cards this card depends on, and the cards that depend on it. Edges to a missing card are ignored. */
  listDependencies(cardId: string): { dependsOn: CardRef[]; dependents: CardRef[] } {
    const refs = (sql: string) => (this.db.prepare(sql).all(cardId) as CardRef[]).map(({ id, title, status }) => ({ id, title, status }));
    return {
      dependsOn: refs("SELECT cards.id, cards.title, cards.status FROM card_dependencies d JOIN cards ON cards.id=d.dependsOn WHERE d.cardId=? ORDER BY cards.createdAt, cards.rowid"),
      dependents: refs("SELECT cards.id, cards.title, cards.status FROM card_dependencies d JOIN cards ON cards.id=d.cardId WHERE d.dependsOn=? ORDER BY cards.createdAt, cards.rowid"),
    };
  }
  /** Refuses an edge to a missing card, to a card on another board, to itself, or one that would close a cycle. */
  private checkDependency(card: Card, dependsOn: string): void {
    if (dependsOn === card.id) throw new Error("A card cannot depend on itself");
    const parent = this.getCard(dependsOn);
    if (!parent) throw new Error(`Dependency not found: ${dependsOn}`);
    if (parent.repo !== card.repo) throw new Error("A card can only depend on cards on the same board");
    // The edge closes a cycle when the new parent already depends, directly or not, on this card.
    const cycle = this.db.prepare(`WITH RECURSIVE reach(id) AS (SELECT ? UNION SELECT d.dependsOn FROM card_dependencies d JOIN reach ON d.cardId=reach.id)
      SELECT 1 FROM reach WHERE id=? LIMIT 1`).get(dependsOn, card.id);
    if (cycle) throw new Error(`Adding this dependency would create a cycle: ${parent.title} already depends on ${card.title}`);
  }
  addDependency(cardId: string, dependsOn: string): Card {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId);
      if (!card) throw new Error("Card not found");
      this.checkDependency(card, dependsOn);
      this.db.prepare("INSERT OR IGNORE INTO card_dependencies(cardId, dependsOn) VALUES (?, ?)").run(cardId, dependsOn);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getCard(cardId)!;
  }
  removeDependency(cardId: string, dependsOn: string): Card {
    if (!this.getCard(cardId)) throw new Error("Card not found");
    if (!this.db.prepare("DELETE FROM card_dependencies WHERE cardId=? AND dependsOn=?").run(cardId, dependsOn).changes) throw new Error("This card does not depend on that card");
    return this.getCard(cardId)!;
  }
  /** Error text for a start refused because some dependencies are not finished, naming each one. */
  private blockedError(cardId: string): Error {
    const waiting = this.listDependencies(cardId).dependsOn.filter(item => item.status !== "done" && item.status !== "archived");
    return new Error(`Waiting on ${waiting.length} unfinished card${waiting.length === 1 ? "" : "s"}: ${waiting.map(item => `${item.title} (${item.id}, ${item.status})`).join("; ")}. Start this card after they are Done.`);
  }
  /** The card created on this board with the key, in any status including archived. */
  getCardByIdempotencyKey(repo: string, key: string): Card | undefined {
    const row = this.db.prepare("SELECT id FROM cards WHERE repo=? AND idempotencyKey=?").get(repo, key) as { id: string } | undefined;
    return row && this.getCard(row.id);
  }
  /** `dependsOn` lists cards on the same board that must be Done before this one starts. */
  createCard(input: { title: string; body: string; repo: string; idempotencyKey?: string | null; priority?: CardPriority; dependsOn?: string[] }): Card {
    const key = input.idempotencyKey ?? null;
    if (key !== null && (!key.trim() || key.length > 200)) throw new Error("Idempotency key must be 1 to 200 characters");
    const existing = key === null ? undefined : this.getCardByIdempotencyKey(input.repo, key);
    if (existing) return existing;
    const id = randomUUID(), time = now();
    this.addRepo(input.repo);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO cards(id, title, body, repo, status, source, idempotencyKey, createdAt, updatedAt, priority) VALUES (?, ?, ?, ?, 'triage', 'manual', ?, ?, ?, ?)")
        .run(id, input.title, input.body, input.repo, key, time, time, parsePriority(input.priority ?? 0));
      for (const parent of new Set(input.dependsOn ?? [])) {
        this.checkDependency(this.getCard(id)!, parent);
        this.db.prepare("INSERT INTO card_dependencies(cardId, dependsOn) VALUES (?, ?)").run(id, parent);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getCard(id)!;
  }
  /**
   * Creates Triage cards from the plan in the card's latest run report and records their ids on the card.
   * Each subtask has a stable idempotency key, so a retry after a partial failure reuses the cards already made.
   * A card whose plan was used once refuses a second set.
   */
  createPlanCards(cardId: string): Card {
    const card = this.getCard(cardId);
    if (!card) throw new Error("Card not found");
    if (card.createdCardIds) throw new Error("Cards were already created from this card's plan");
    const report = this.listRuns(cardId)[0]?.report;
    const plan = report ? parsePlan(report) : null;
    if (!plan || "error" in plan) throw new Error(plan ? plan.error : "This card has no plan report");
    const made = new Map<string, string>();
    for (const task of plan.subtasks) {
      made.set(task.id, this.createCard({ title: task.title, body: `${task.body}\n\nPart of the plan from card ${card.id}: ${card.title}`, repo: card.repo,
        idempotencyKey: `plan:${card.id}:${task.id}`, dependsOn: task.dependsOn.map(dep => made.get(dep)!) }).id);
    }
    this.db.prepare("UPDATE cards SET createdCardIds=? WHERE id=?").run(JSON.stringify([...made.values()]), cardId);
    return this.getCard(cardId)!;
  }
  updateCard(id: string, input: { title: string; body: string; repo: string; priority?: CardPriority }): Card {
    const card = this.getCard(id);
    if (!card) throw new Error("Card not found");
    if (card.status === "running") throw new Error("Cannot edit a running card");
    if (input.repo !== card.repo) throw new Error("Cannot change a card's repository; create a card on the other board");
    this.db.prepare("UPDATE cards SET title=?, body=?, priority=?, updatedAt=? WHERE id=?").run(input.title, input.body, parsePriority(input.priority ?? card.priority), now(), id);
    return this.getCard(id)!;
  }
  setStatus(id: string, status: "triage" | "ready" | "done"): Card {
    const card = this.getCard(id);
    if (!card) throw new Error("Card not found");
    if (card.status === "running" || card.status === "interrupted") throw new Error("Resolve the active or interrupted run first");
    if (card.status === "archived") throw new Error("Restore this archived card to Done first");
    if (this.getApproval(id)) throw new Error("Approval is in progress; retry Approve and merge into local main");
    if (status === "triage" && (card.status !== "ready" || this.listRuns(id).length)) throw new Error("Only unstarted Ready cards can move to Triage");
    if (status === "done" && this.listRuns(id).length) throw new Error("Cards with run work cannot be marked Done without approval and integration");
    // Recover cards closed by the old status-only action without launching another Pi run.
    if (status === "ready" && card.status === "done" && this.listRuns(id)[0]?.status === "review" && !this.wasIntegrated(id)) {
      this.db.prepare("UPDATE cards SET status='review', updatedAt=? WHERE id=?").run(now(), id);
      this.explain(id, "Reopened; its work was never merged, so it is back for review");
      return this.getCard(id)!;
    }
    this.db.prepare("UPDATE cards SET status=?, updatedAt=? WHERE id=?").run(status, now(), id);
    this.explain(id, card.status === "done" ? "Reopened" : status === "done" ? "Marked done without a run" : status === "ready" ? "Moved to Ready" : "Moved back to Triage");
    return this.getCard(id)!;
  }
  // Drops a Review card without merging. The run, worktree and branch stay, so Reopen can bring it back.
  closeReview(id: string): Card {
    const card = this.getCard(id);
    if (!card) throw new Error("Card not found");
    if (card.status !== "review") throw new Error("Only Review cards can be closed without merging");
    if (this.getApproval(id)) throw new Error("Approval is in progress; retry Approve and merge into local main");
    this.db.prepare("UPDATE cards SET status='done', updatedAt=? WHERE id=?").run(now(), id);
    this.explain(id, "Closed without merging; the worktree and branch stay, and Reopen brings it back to Review");
    return this.getCard(id)!;
  }
  // Archiving only hides Done cards in a separate lane. It never touches runs, worktrees, or Git.
  setArchived(repo: string, ids: string[], archived: boolean): Card[] {
    const unique = [...new Set(ids)];
    if (!unique.length || unique.length > 500) throw new Error("Select between 1 and 500 cards");
    const from = archived ? "done" : "archived", to = archived ? "archived" : "done";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of unique) {
        const card = this.getCard(id);
        if (!card || card.repo !== repo) throw new Error("Card not found on this board");
        if (card.status !== from) throw new Error(archived ? "Only Done cards can be archived" : "Only archived cards can be restored");
      }
      const time = now(), update = this.db.prepare("UPDATE cards SET status=?, updatedAt=? WHERE id=?");
      for (const id of unique) { update.run(to, time, id); this.explain(id, archived ? "Archived" : "Restored from the archive"); }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return unique.map(id => this.getCard(id)!);
  }
  listDiscussion(cardId: string): DiscussionMessage[] {
    const attachments = this.listAttachments(cardId);
    return (this.db.prepare("SELECT * FROM discussion_messages WHERE cardId=? ORDER BY rowid").all(cardId) as Omit<DiscussionMessage, "attachments">[])
      .map(message => ({ ...message, attachments: attachments.filter(item => item.messageId === message.id) }));
  }
  /** `attachmentIds` must be this card's attachments not yet sent with another message; they move onto the new message. */
  addDiscussionMessage(cardId: string, role: DiscussionMessage["role"], body: string, attachmentIds: string[] = []): DiscussionMessage {
    const message = { id: randomUUID(), cardId, role, body, createdAt: now() };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO discussion_messages(id, cardId, role, body, createdAt) VALUES (?, ?, ?, ?, ?)").run(message.id, cardId, role, body, message.createdAt);
      const link = this.db.prepare("UPDATE attachments SET messageId=? WHERE id=? AND cardId=? AND messageId IS NULL");
      for (const id of new Set(attachmentIds))
        if (Number(link.run(message.id, id, cardId).changes) !== 1) throw new Error(`Attachment ${id} is not an unsent file on this card`);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { ...message, attachments: this.listAttachments(cardId).filter(item => item.messageId === message.id) };
  }
  addAttachment(input: { id: string; cardId: string; name: string; type: string; size: number }): Attachment {
    const attachment = { ...input, messageId: null, createdAt: now() };
    this.db.prepare("INSERT INTO attachments(id, cardId, messageId, name, type, size, createdAt) VALUES (?, ?, NULL, ?, ?, ?, ?)")
      .run(attachment.id, attachment.cardId, attachment.name, attachment.type, attachment.size, attachment.createdAt);
    return attachment;
  }
  listAttachments(cardId: string): Attachment[] {
    return this.db.prepare("SELECT * FROM attachments WHERE cardId=? ORDER BY createdAt, rowid").all(cardId) as Attachment[];
  }
  allAttachmentKeys(): { cardId: string; id: string }[] {
    return this.db.prepare("SELECT cardId, id FROM attachments").all() as { cardId: string; id: string }[];
  }
  deleteAttachment(cardId: string, id: string) {
    this.db.prepare("DELETE FROM attachments WHERE cardId=? AND id=?").run(cardId, id);
  }
  getAttachment(cardId: string, id: string): Attachment | undefined {
    return this.db.prepare("SELECT * FROM attachments WHERE cardId=? AND id=?").get(cardId, id) as Attachment | undefined;
  }
  listChats(boardId: string): Chat[] {
    return this.db.prepare("SELECT * FROM chats WHERE boardId=? ORDER BY updatedAt DESC, rowid DESC").all(boardId) as Chat[];
  }
  getChat(id: string): Chat | undefined { return this.db.prepare("SELECT * FROM chats WHERE id=?").get(id) as Chat | undefined; }
  createChat(boardId: string, title = ""): Chat {
    const time = now(), chat = { id: randomUUID(), boardId, title, createdAt: time, updatedAt: time };
    this.db.prepare("INSERT INTO chats(id, boardId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").run(chat.id, boardId, title, time, time);
    return chat;
  }
  renameChat(id: string, title: string): Chat {
    this.db.prepare("UPDATE chats SET title=? WHERE id=?").run(title, id);
    return this.getChat(id)!;
  }
  deleteChat(id: string) {
    this.db.prepare("DELETE FROM chat_messages WHERE chatId=?").run(id);
    this.db.prepare("DELETE FROM chats WHERE id=?").run(id);
  }
  listChatMessages(chatId: string): ChatMessage[] {
    return (this.db.prepare("SELECT * FROM chat_messages WHERE chatId=? ORDER BY rowid").all(chatId) as (Omit<ChatMessage, "parts"> & { parts: string })[])
      .map(row => ({ ...row, parts: JSON.parse(row.parts) as ChatPart[] }));
  }
  /** Saves a message and bumps the chat to the top of its board's list. An untitled chat takes its first message as title. */
  addChatMessage(chatId: string, role: ChatMessage["role"], body: string, parts: ChatPart[] = []): ChatMessage {
    const message = { id: randomUUID(), chatId, role, body, parts, createdAt: now() };
    this.db.prepare("INSERT INTO chat_messages(id, chatId, role, body, parts, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(message.id, chatId, role, body, JSON.stringify(parts), message.createdAt);
    this.db.prepare("UPDATE chats SET updatedAt=?, title=CASE WHEN title='' AND ?='user' THEN ? ELSE title END WHERE id=?").run(message.createdAt, role, chatTitle(body), chatId);
    return message;
  }
  listReviewComments(cardId: string): ReviewComment[] {
    return this.db.prepare("SELECT * FROM review_comments WHERE cardId=? ORDER BY createdAt, id").all(cardId) as ReviewComment[];
  }
  /** A comment with an empty `path` is general: it belongs to the review, not to a line (line 0, no code). */
  addReviewComment(cardId: string, runId: string, fingerprint: string, path: string, line: number, kind: ReviewComment["kind"], code: string, body: string, fileLine: number | null = null): ReviewComment {
    if (!body.trim() || body.length > 1000 || path.length > 1000 || code.length > 10000 || !Number.isSafeInteger(line) || line < (path ? 1 : 0) || (!path && (line !== 0 || code || fileLine !== null)) || (fileLine !== null && (!Number.isSafeInteger(fileLine) || fileLine < 1))) throw new Error("Invalid review comment");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId), run = this.listRuns(cardId)[0];
      if (card?.status !== "review" || run?.id !== runId || run.status !== "review" || this.getApproval(cardId)) throw new Error("Only the latest unapproved review accepts comments");
      if (this.hasRequestedChanges(cardId, runId)) throw new Error("Changes already requested for this review; run Pi again to revise it");
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM review_comments WHERE cardId=? AND runId=? AND state='draft'").get(cardId, runId) as { n: number };
      if (count.n >= 25) throw new Error("Limit of 25 draft comments per review");
      const id = randomUUID();
      this.db.prepare("INSERT INTO review_comments(id,cardId,runId,fingerprint,path,line,fileLine,kind,code,body,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, cardId, runId, fingerprint, path, line, fileLine, kind, code, body.trim(), now());
      this.db.exec("COMMIT");
      return this.db.prepare("SELECT * FROM review_comments WHERE id=?").get(id) as ReviewComment;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  deleteReviewComment(cardId: string, id: string): void {
    const result = this.db.prepare("DELETE FROM review_comments WHERE id=? AND cardId=? AND state='draft'").run(id, cardId);
    if (!result.changes) throw new Error("Only draft comments can be removed");
  }
  hasRequestedChanges(cardId: string, runId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM review_comments WHERE cardId=? AND runId=? AND state='requested' LIMIT 1").get(cardId, runId);
  }
  hasDraftReviewComments(cardId: string, runId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM review_comments WHERE cardId=? AND runId=? AND state='draft' LIMIT 1").get(cardId, runId);
  }
  requestChanges(cardId: string, runId: string, fingerprint: string): ReviewComment[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId), run = this.listRuns(cardId)[0];
      if (card?.status !== "review" || run?.id !== runId || run.status !== "review" || this.getApproval(cardId)) throw new Error("Only the latest unapproved review can request changes");
      if (this.hasRequestedChanges(cardId, runId)) throw new Error("Changes already requested for this review");
      if (this.db.prepare("SELECT 1 FROM review_comments WHERE cardId=? AND runId=? AND fingerprint<>? AND state='draft'").get(cardId, runId, fingerprint)) throw new Error("Remove draft comments on older diffs before requesting changes");
      const result = this.db.prepare("UPDATE review_comments SET state='requested' WHERE cardId=? AND runId=? AND fingerprint=? AND state='draft'").run(cardId, runId, fingerprint);
      if (!result.changes) throw new Error("Add comments on the current diff before requesting changes");
      this.noteCard(cardId, `Changes requested on attempt ${run.attempt} (${result.changes} comment${result.changes === 1 ? "" : "s"}); they go to Pi on the next run`);
      this.db.exec("COMMIT");
      return this.listReviewComments(cardId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  getFeedbackForRun(cardId: string): ReviewComment[] {
    return this.db.prepare(`SELECT review_comments.* FROM review_comments JOIN runs ON runs.id=review_comments.runId
      WHERE review_comments.cardId=? AND review_comments.state='requested' AND runs.status='review'
      AND runs.attempt=(SELECT MAX(attempt) FROM runs WHERE cardId=? AND status='review') ORDER BY review_comments.createdAt, review_comments.id`).all(cardId, cardId) as ReviewComment[];
  }
  getMergeFailure(cardId: string): MergeFailure | undefined {
    const row = this.db.prepare("SELECT * FROM merge_failures WHERE cardId=?").get(cardId) as { cardId: string; files: string; details: string } | undefined;
    return row && { cardId: row.cardId, files: JSON.parse(row.files) as string[], details: row.details };
  }
  listMergeFailures(repo: string): MergeFailure[] {
    return (this.db.prepare("SELECT merge_failures.* FROM merge_failures JOIN cards ON cards.id=merge_failures.cardId WHERE cards.repo=? AND cards.status IN ('review', 'failed')").all(repo) as { cardId: string; files: string; details: string }[])
      .map(row => ({ cardId: row.cardId, files: JSON.parse(row.files) as string[], details: row.details }));
  }
  recordMergeFailure(cardId: string, files: string[], details: string): void {
    this.db.prepare("INSERT INTO merge_failures(cardId, files, details) VALUES (?, ?, ?) ON CONFLICT(cardId) DO UPDATE SET files=excluded.files, details=excluded.details")
      .run(cardId, JSON.stringify(files), details);
  }
  clearMergeFailure(cardId: string): void { this.db.prepare("DELETE FROM merge_failures WHERE cardId=?").run(cardId); }
  getApproval(cardId: string): Approval | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE cardId=? AND merged=0").get(cardId) as Approval | undefined;
  }
  wasIntegrated(cardId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM approvals WHERE cardId=? AND merged=1 UNION SELECT 1 FROM external_integrations WHERE cardId=?").get(cardId, cardId);
  }
  listExternalMergeCandidates(): { card: Card; run: Run }[] {
    const ids = this.db.prepare(`SELECT cards.id FROM cards JOIN runs ON runs.cardId=cards.id
      WHERE cards.status IN ('review', 'failed') AND runs.attempt=(SELECT MAX(attempt) FROM runs WHERE cardId=cards.id)
        AND runs.worktree IS NOT NULL AND NOT EXISTS (SELECT 1 FROM approvals WHERE cardId=cards.id AND merged=0)
        AND NOT EXISTS (SELECT 1 FROM boards WHERE boards.repo=cards.repo AND boards.integration='github-pr')
      ORDER BY cards.updatedAt`).all() as { id: string }[];
    return ids.map(({ id }) => ({ card: this.getCard(id)!, run: this.listRuns(id)[0] }));
  }
  recordExternalIntegration(cardId: string, runId: string, candidate: string, mergeCommit: string): Card {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId), run = this.listRuns(cardId)[0];
      if (!card || !['review', 'failed'].includes(card.status) || run?.id !== runId ||
        this.getApproval(cardId) || this.wasIntegrated(cardId)) throw new Error("Card changed during external merge reconciliation");
      this.db.prepare("INSERT INTO external_integrations(cardId, runId, candidate, mergeCommit, integratedAt) VALUES (?, ?, ?, ?, ?)")
        .run(cardId, runId, candidate, mergeCommit, now());
      this.db.prepare("UPDATE cards SET status='done', updatedAt=? WHERE id=?").run(now(), cardId);
      this.explain(cardId, `Merged outside Bakery; ${mergeCommit.slice(0, 7)} contains this card's work`);
      this.clearMergeFailure(cardId);
      this.db.exec("COMMIT");
      return this.getCard(cardId)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  recordApproval(cardId: string, runId: string, candidate: string): Approval {
    const card = this.getCard(cardId), run = this.listRuns(cardId)[0];
    if (card?.status !== "review" || run?.id !== runId || run.status !== "review") throw new Error("Only the latest reviewed run can be approved");
    if (this.getApproval(cardId)) throw new Error("Approval already in progress");
    if (this.hasRequestedChanges(cardId, runId)) throw new Error("Changes requested; review a new attempt before approving");
    this.db.prepare("INSERT INTO approvals(cardId, runId, candidate, merged) VALUES (?, ?, ?, 0) ON CONFLICT(cardId) DO UPDATE SET runId=excluded.runId, candidate=excluded.candidate, preparedHead=NULL, merged=0").run(cardId, runId, candidate);
    this.clearMergeFailure(cardId);
    return this.getApproval(cardId)!;
  }
  cancelApproval(cardId: string, runId: string, includePrepared = false): void {
    this.db.prepare(`DELETE FROM approvals WHERE cardId=? AND runId=? AND merged=0 ${includePrepared ? "" : "AND preparedHead IS NULL"}`).run(cardId, runId);
  }
  recordPreparedMerge(cardId: string, runId: string, candidate: string, preparedHead: string): void {
    const approval = this.getApproval(cardId);
    if (approval?.runId !== runId || approval.candidate !== candidate || this.getCard(cardId)?.status !== "review") throw new Error("Approval state changed");
    this.db.prepare("UPDATE approvals SET preparedHead=? WHERE cardId=? AND merged=0").run(preparedHead, cardId);
  }
  completeApproval(cardId: string, runId: string, candidate: string): Card {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId), run = this.listRuns(cardId)[0], approval = this.getApproval(cardId);
      if (card?.status !== "review" || run?.id !== runId || run.status !== "review" || approval?.candidate !== candidate || approval.runId !== runId) throw new Error("Approval state changed");
      this.db.prepare("UPDATE cards SET status='done', updatedAt=? WHERE id=?").run(now(), cardId);
      this.explain(cardId, `Attempt ${run.attempt} approved and merged into local main`);
      this.db.prepare("UPDATE approvals SET merged=1 WHERE cardId=?").run(cardId);
      this.clearMergeFailure(cardId);
      this.db.exec("COMMIT");
      return this.getCard(cardId)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  resolveInterrupted(id: string): Card {
    const card = this.getCard(id);
    if (!card || card.status !== "interrupted") throw new Error("Card is not interrupted");
    const run = this.listRuns(id)[0];
    if (run?.pid) {
      try { process.kill(run.pid, 0); throw new Error(`Process ${run.pid} may still be running; stop and inspect it first`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    this.db.prepare("UPDATE cards SET status='failed', updatedAt=? WHERE id=?").run(now(), id);
    this.explain(id, "Released after the interrupted run's process was confirmed gone");
    return this.getCard(id)!;
  }
  /** `why` says what asked for the run, for the card's history (e.g. the agent reviewer sending it back). */
  claim(cardId: string, startedBy: "manual" | "auto" = "manual", why = ""): Run {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId);
      if (!card) throw new Error("Card not found");
      if (card.status === "running") throw new Error("Card already has an active run");
      if (card.status === "interrupted") throw new Error("Resolve the interrupted process before retrying");
      if (card.status === "done") throw new Error("Reopen this card before starting a run");
      if (card.status === "archived") throw new Error("Restore this archived card before starting a run");
      if (card.status === "triage") throw new Error("Move this card to Ready before starting a run");
      // Manual and automatic starts both claim here, so neither can skip the dependency gate.
      if (waitsOnDependencies(card)) throw this.blockedError(cardId);
      if (this.getApproval(cardId)) throw new Error("Approval is in progress; retry Approve and merge into local main");
      if (this.db.prepare("SELECT 1 FROM auto_review_jobs WHERE cardId=? AND state='running' LIMIT 1").get(cardId))
        throw new Error("Agent review is in progress; wait for its result before running Pi again");
      const repoBoard = this.listBoards().find(item => item.repo === card.repo);
      if (repoBoard?.autoPickupEnabled && this.runningCount(card.repo) >= repoBoard.pickupConcurrency)
        throw new RunLimitError(`Repository is at its ${repoBoard.pickupConcurrency}-run concurrency limit`);
      if (startedBy === "auto" && (card.status !== "ready" || !repoBoard?.autoPickupEnabled ||
        (repoBoard.pickupDailyLimit > 0 && this.autoStartsToday(card.repo) >= repoBoard.pickupDailyLimit) || repoBoard.autoPickupBudgetReached || repoBoard.integrationError || this.autoPickupBlocker(repoBoard)))
        throw new Error("Automatic pickup is not eligible for this card");
      const attempt = Number((this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE cardId=?").get(cardId) as { n: number }).n) + 1;
      const id = randomUUID(), sessionId = `bakery-${cardId}`;
      this.db.prepare("INSERT INTO runs(id, cardId, attempt, status, sessionId, startedAt, startedBy, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost) VALUES (?, ?, ?, 'running', ?, ?, ?, 0, 0, 0, 0, 0)").run(id, cardId, attempt, sessionId, now(), startedBy);
      this.db.prepare("UPDATE cards SET status='running', updatedAt=? WHERE id=?").run(now(), cardId);
      this.explain(cardId, `Attempt ${attempt} started${why ? ` ${why}` : startedBy === "auto" ? " by auto-pickup" : ""}`);
      this.db.exec("COMMIT");
      return this.getRun(id)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Attaches a reason to the status change the card_status_events trigger just recorded for this card. */
  private explain(cardId: string, reason: string): void {
    this.db.prepare("UPDATE card_events SET reason=? WHERE id=(SELECT MAX(id) FROM card_events WHERE cardId=? AND toStatus IS NOT NULL) AND reason=''").run(reason.slice(0, 2000), cardId);
  }
  /** Records something worth knowing about a card that did not change its status, such as a failed restart. */
  noteCard(cardId: string, reason: string): void {
    this.db.prepare("INSERT INTO card_events(cardId, at, reason) VALUES (?, ?, ?)").run(cardId, now(), reason.slice(0, 2000));
  }
  listCardEvents(cardId: string): CardEvent[] {
    return this.db.prepare("SELECT at, fromStatus, toStatus, reason FROM card_events WHERE cardId=? ORDER BY id").all(cardId) as CardEvent[];
  }
  getRun(id: string): Run | undefined { return this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Run | undefined; }
  listRuns(cardId: string): Run[] { return this.db.prepare("SELECT * FROM runs WHERE cardId=? ORDER BY attempt DESC").all(cardId) as Run[]; }
  attach(id: string, pid: number, worktree: string) { this.db.prepare("UPDATE runs SET pid=?, worktree=?, lastActivityAt=? WHERE id=? AND status='running'").run(pid, worktree, now(), id); }
  /** The run's agent reported something. Lets the board tell a working run from a quiet one. */
  touch(id: string) { this.db.prepare("UPDATE runs SET lastActivityAt=? WHERE id=? AND status='running'").run(now(), id); }
  recordAgent(id: string, label: string) {
    const run = this.getRun(id);
    if (run?.status === "running") this.db.prepare("UPDATE runs SET agent=? WHERE id=?").run(addAgent(run.agent, label), id);
  }
  recordUsage(id: string, usage: Usage) {
    this.db.prepare(`UPDATE runs SET ${usageUpdate} WHERE id=? AND status='running'`).run(...usageValues(usage), id);
  }
  /** Each assistant message replaces the last, so a settled run keeps its final message. */
  recordReport(id: string, text: string) {
    const report = text.trim();
    if (report) this.db.prepare("UPDATE runs SET report=? WHERE id=? AND status='running'").run(report.slice(0, 60000), id);
  }
  /** Closes a reviewed run that changed no files. The report is the card's result; nothing is merged. */
  acceptFindings(cardId: string, runId: string): Card {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const card = this.getCard(cardId), run = this.listRuns(cardId)[0];
      if (card?.status !== "review" || run?.id !== runId || run.status !== "review") throw new Error("Card changed since review; refresh and try again");
      if (this.getApproval(cardId)) throw new Error("Approval is in progress; retry or withdraw it first");
      this.db.prepare("UPDATE cards SET status='done', updatedAt=? WHERE id=?").run(now(), cardId);
      this.explain(cardId, "Findings accepted; the run changed no files, so nothing was merged");
      this.db.exec("COMMIT");
      return this.getCard(cardId)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  completeTurn(id: string) { this.db.prepare("UPDATE runs SET turns=turns+1 WHERE id=? AND status='running'").run(id); }
  append(id: string, chunk: string) {
    // Keep a bounded tail. Store only human-readable text; never raw tool arguments or credentials.
    const run = this.getRun(id);
    if (run?.status !== "running") return;
    this.db.prepare("UPDATE runs SET output=? WHERE id=?").run((run.output + chunk).slice(-60000), id);
  }
  finish(id: string, status: "review" | "failed", error: string | null = null) {
    const run = this.getRun(id);
    if (!run || run.status !== "running") return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE runs SET status=?, error=?, finishedAt=? WHERE id=? AND status='running'").run(status, error, now(), id);
      this.db.prepare("UPDATE cards SET status=?, updatedAt=? WHERE id=?").run(status, now(), run.cardId);
      this.explain(run.cardId, status === "review" ? `Attempt ${run.attempt} finished; waiting for review` : `Attempt ${run.attempt} failed: ${error ?? "unknown error"}`);
      if (status === "review") this.clearMergeFailure(run.cardId);
      this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }
}
