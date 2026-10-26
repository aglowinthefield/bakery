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
  agentModels?: AgentModels;
  cardCounts?: Partial<Record<Status, number>>;
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
};
export type BakerySettings = {
  confirmRunStart: boolean;
  notifyOnReview: boolean;
  cardDetailsLayout: "dialog" | "side";
  theme: "default" | "compline" | "light";
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
export type ReviewDiff = {
  cardId: string;
  fingerprint: string;
  files: { path: string; patch: string }[];
};
export type Card = {
  id: string;
  title: string;
  body: string;
  repo: string;
  source: "manual";
  status: Status;
  createdAt: string;
  updatedAt: string;
  turns: number;
  turnsIncomplete: number;
  attempts: number;
  reviewRounds: number;
  runAgent: string;
  reviewAgent: string;
};
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
};
