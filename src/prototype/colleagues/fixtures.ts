// Fictional fixture data for the colleagues prototype. Nothing here comes from or goes to Bakery, Pi, or Impression.

export interface Project {
  id: string;
  name: string;
  /** The board's New cards policy. */
  newCards: "ready" | "triage";
  autoPickup: boolean;
}

export interface Rule {
  keywords: string[];
  text: string;
}

export interface StandupFixture {
  completed: string;
  active: string;
  blocked: string;
  proposed: string;
}

export interface Colleague {
  id: string;
  name: string;
  specialty: string;
  summary: string;
  instructions: string;
  model: string;
  projects: string[];
  replies: Rule[];
  interjections: Rule[];
  /** null means no activity in the standup window. */
  standup: StandupFixture | null;
  /** The first standup report fails, to show a partial summary and Retry. */
  standupFailsFirst?: boolean;
}

export interface Memory {
  id: string;
  title: string;
  content: string;
  scope: "user" | "project";
  project?: string;
  source: string;
  stale?: string;
}

export const projects: Project[] = [
  { id: "silk", name: "Silk", newCards: "ready", autoPickup: true },
  { id: "bakery", name: "Bakery", newCards: "triage", autoPickup: false },
  { id: "coda", name: "Coda", newCards: "ready", autoPickup: false },
];

export const colleagues: Colleague[] = [
  {
    id: "ingest",
    name: "Ingest",
    specialty: "Silk AI ingestion",
    summary: "Imports, enrichment, and pipeline quality.",
    instructions:
      "Prefer idempotent pipeline stages. Cite the stage and table you would change.",
    model: "fixture-large · thinking medium",
    projects: ["silk"],
    replies: [
      {
        keywords: ["last week"],
        text: "Last week's failure (fixture card SILK-118) retried the whole import, which minted new media IDs. This time only the enrichment stage reruns, keyed on the existing media record, so the import identity never changes.",
      },
      {
        keywords: ["schema", "migration"],
        text: "Agreed. The retry stays inside the existing media table with an idempotency key on the enrichment job. No migration is needed.",
      },
      {
        keywords: ["retry", "duplicat", "enrich"],
        text: "Retry the enrichment stage against the existing media record. Keep import identity unchanged and make the retry idempotent, keyed on media ID plus enrichment version.",
      },
    ],
    interjections: [
      {
        keywords: ["ranking", "reindex", "search"],
        text: "One risk: a reindex during enrichment reads half-written records. Gate it on the enrichment version.",
      },
    ],
    standup: {
      completed: "SILK-121 Dedupe import keys (fixture)",
      active: "SILK-124 Retry enrichment without duplicates (fixture)",
      blocked: "No known blocker",
      proposed:
        "Backfill enrichment for 40 failed imports. Suggestion, not an assignment.",
    },
  },
  {
    id: "scout",
    name: "Scout",
    specialty: "Search & discovery",
    summary: "Relevance, ranking, and useful connections.",
    instructions: "Flag ranking side effects of data changes.",
    model: "fixture-medium · thinking low",
    projects: ["silk"],
    replies: [
      {
        keywords: ["ranking", "reindex", "search"],
        text: "Ranking does not need a full reindex. Only items whose enrichment version changes get re-scored, in the nightly batch.",
      },
    ],
    interjections: [
      {
        keywords: ["retry", "duplicat", "enrich"],
        text: "One dependency: related-media ranking still needs the original metadata while enrichment is pending.",
      },
    ],
    standup: {
      completed: "SILK-117 Related-media scoring (fixture)",
      active: "SILK-119 Keep original metadata for ranking (fixture)",
      blocked: "Waiting on SILK-124 for the enrichment version field",
      proposed:
        "Add a ranking regression set for retried items. Suggestion, not an assignment.",
    },
    standupFailsFirst: true,
  },
  {
    id: "relay",
    name: "Relay",
    specialty: "Reliability",
    summary: "Recovery, interrupted work, and safe handoffs.",
    instructions: "Look for partial writes and unsafe retries.",
    model: "fixture-large · thinking high",
    projects: ["bakery", "coda"],
    replies: [
      {
        keywords: ["queue", "stop", "restart"],
        text: "Persist the queue before acknowledging a send, and fence output from cancelled rounds by round ID.",
      },
    ],
    interjections: [
      {
        keywords: ["schema", "migration", "cancel"],
        text: "Risk: a cancelled retry can leave a half-written enrichment row. Write it in one transaction.",
      },
    ],
    standup: null,
  },
];

export const memories: Memory[] = [
  {
    id: "imp_7f3a21",
    title: "Retries must not mint new media IDs",
    content:
      "Decision: enrichment retries reuse the existing media record. Import identity is stable.",
    scope: "project",
    project: "silk",
    source: "Room “Ingestion triage”, 2026-10-28",
  },
  {
    id: "imp_2c9e04",
    title: "Older pipeline decision: retry whole imports",
    content:
      "Retry failed imports end to end. Superseded by the stable-identity decision.",
    scope: "project",
    project: "silk",
    source: "Card SILK-097, 2026-06-02",
    stale:
      "Older than repository evidence: the import stage changed since this was saved.",
  },
  {
    id: "imp_51d8b7",
    title: "Operator prefers no schema migrations mid-quarter",
    content: "Avoid migrations unless a decision explicitly needs one.",
    scope: "user",
    source: "Room “Planning”, 2026-09-14",
  },
  {
    id: "imp_9a0f33",
    title: "Bakery runs use one worktree per card",
    content: "Card implementation happens in a dedicated worktree, not a room.",
    scope: "project",
    project: "bakery",
    source: "docs/reference.md, 2026-10-02",
  },
];

/** Composer shortcuts for the review walkthrough. */
export const suggestions = [
  "How should we retry enrichment without duplicating media?",
  "Compare this with last week's failure.",
  "Preserve the schema. No migration.",
  "@Scout does ranking need a reindex?",
];

/** Unresolved spec choices that this prototype picked so the flow is clickable. */
export const assumptions = [
  "“Colleague” is used as the product name; the spec leaves it provisional.",
  "Start chat reuses an existing direct room with that colleague instead of starting a fresh topic.",
  "A message sent while the queue is paused stays queued until Resume queue or Steer now.",
  "Mention-only mode skips the interjection pass; the lead still answers unaddressed messages.",
  "Interjections come from keyword rules on fixture text, capped at two per round; the real screening pass and selection are undecided.",
  "The first standup reports on the previous 24 hours. The summary is attributed to the room lead.",
  "The handoff preselects the originating colleague as assignee, with a board-default override.",
  "Retrying a failed standup report regenerates the summary from all reports.",
  "Remember (explicit memory saving) is not part of this prototype.",
];
