// Aggregates what Bakery already records per card (runs, agent reviews, usage) for the Statistics page.
export type StatsRun = { repo: string; cardId: string; status: string; startedBy: string; agent: string; ciFix: number; startedAt: string; finishedAt: string | null; cost: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null };
export type StatsReview = { repo: string; state: string; agent: string; startedAt: string; finishedAt: string | null; cost: number | null };
export type StatsCard = { repo: string; status: string; createdAt: string; updatedAt: string; attempts: number; reviewRounds: number; ciReworks: number };
export type StatsInput = { runs: StatsRun[]; reviews: StatsReview[]; cards: StatsCard[] };
export type StatsOptions = { days: number | null; repo: string | null; now?: number };

export type DayPoint = { date: string; succeeded: number; failed: number; interrupted: number; cost: number; created: number; done: number; reviewCost: number };
export type GroupRow = { name: string; runs: number; failed: number; cost: number; tokens: number; avgMinutes: number | null };
export type Stats = {
  days: number | null;
  summary: { cardsCreated: number; cardsDone: number; runs: number; successRate: number | null; cost: number; tokens: number; avgRunMinutes: number | null; avgLeadHours: number | null; autoShare: number | null; reviewRounds: number; ciReworks: number; agentReviews: number; agentReviewsMerged: number };
  daily: DayPoint[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  byAgent: GroupRow[];
  byRepo: GroupRow[];
  cardStatus: { status: string; count: number }[];
};

// SQLite's datetime('now') has no zone; read it as UTC like the ISO strings.
export const parseTime = (value: string | null): number | null => {
  if (!value) return null;
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(time) ? null : time;
};
const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);
const sum = (values: (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
const average = (values: number[]) => values.length ? sum(values) / values.length : null;
const runMinutes = (run: { startedAt: string; finishedAt: string | null }) => {
  const start = parseTime(run.startedAt), end = parseTime(run.finishedAt);
  return start !== null && end !== null && end >= start ? (end - start) / 60_000 : null;
};
const runTokens = (run: StatsRun) => sum([run.inputTokens, run.outputTokens, run.cacheReadTokens, run.cacheWriteTokens]);

function group(runs: StatsRun[], key: (run: StatsRun) => string): GroupRow[] {
  const rows = new Map<string, StatsRun[]>();
  for (const run of runs) rows.set(key(run), [...(rows.get(key(run)) ?? []), run]);
  return [...rows].map(([name, items]) => ({
    name, runs: items.length, failed: items.filter(run => run.status === "failed").length,
    cost: sum(items.map(run => run.cost)), tokens: sum(items.map(runTokens)),
    avgMinutes: average(items.map(runMinutes).filter((value): value is number => value !== null)),
  })).sort((a, b) => b.cost - a.cost || b.runs - a.runs);
}

export function buildStats(input: StatsInput, options: StatsOptions): Stats {
  const now = options.now ?? Date.now();
  const since = options.days === null ? -Infinity : now - options.days * 86_400_000;
  const inRange = (value: string | null) => (parseTime(value) ?? -Infinity) >= since;
  const inRepo = (item: { repo: string }) => !options.repo || item.repo === options.repo;
  const runs = input.runs.filter(run => inRepo(run) && inRange(run.startedAt) && run.status !== "running");
  const reviews = input.reviews.filter(review => inRepo(review) && inRange(review.startedAt));
  const cards = input.cards.filter(inRepo);
  const created = cards.filter(card => inRange(card.createdAt));
  const done = cards.filter(card => (card.status === "done" || card.status === "archived") && inRange(card.updatedAt));

  // Daily buckets cover the whole window, or run from the first record when the window is unbounded.
  const first = options.days === null
    ? Math.min(now, ...[...runs.map(run => run.startedAt), ...created.map(card => card.createdAt)].map(value => parseTime(value) ?? now))
    : now - (options.days - 1) * 86_400_000;
  const daily = new Map<string, DayPoint>();
  for (let time = Date.parse(dayKey(first)); time <= now; time += 86_400_000) {
    const date = dayKey(time);
    daily.set(date, { date, succeeded: 0, failed: 0, interrupted: 0, cost: 0, created: 0, done: 0, reviewCost: 0 });
  }
  const bucket = (value: string | null) => { const time = parseTime(value); return time === null ? undefined : daily.get(dayKey(time)); };
  for (const run of runs) {
    const point = bucket(run.startedAt);
    if (!point) continue;
    if (run.status === "failed") point.failed++; else if (run.status === "interrupted") point.interrupted++; else point.succeeded++;
    point.cost += run.cost ?? 0;
  }
  for (const review of reviews) { const point = bucket(review.startedAt); if (point) { point.cost += review.cost ?? 0; point.reviewCost += review.cost ?? 0; } }
  for (const card of created) { const point = bucket(card.createdAt); if (point) point.created++; }
  for (const card of done) { const point = bucket(card.updatedAt); if (point) point.done++; }

  const finished = runs.filter(run => run.status !== "interrupted");
  const leadHours = done.map(card => {
    const start = parseTime(card.createdAt), end = parseTime(card.updatedAt);
    return start !== null && end !== null && end >= start ? (end - start) / 3_600_000 : null;
  }).filter((value): value is number => value !== null);
  const cost = sum(runs.map(run => run.cost)) + sum(reviews.map(review => review.cost));
  const statusCounts = new Map<string, number>();
  for (const card of cards) statusCounts.set(card.status, (statusCounts.get(card.status) ?? 0) + 1);
  return {
    days: options.days,
    summary: {
      cardsCreated: created.length, cardsDone: done.length, runs: runs.length,
      successRate: finished.length ? finished.filter(run => run.status !== "failed").length / finished.length : null,
      cost, tokens: sum(runs.map(runTokens)),
      avgRunMinutes: average(runs.map(runMinutes).filter((value): value is number => value !== null)),
      avgLeadHours: average(leadHours),
      autoShare: runs.length ? runs.filter(run => run.startedBy === "auto").length / runs.length : null,
      reviewRounds: sum(created.map(card => card.reviewRounds)), ciReworks: sum(created.map(card => card.ciReworks)),
      agentReviews: reviews.length, agentReviewsMerged: reviews.filter(review => review.state === "merged").length,
    },
    daily: [...daily.values()],
    tokens: { input: sum(runs.map(run => run.inputTokens)), output: sum(runs.map(run => run.outputTokens)), cacheRead: sum(runs.map(run => run.cacheReadTokens)), cacheWrite: sum(runs.map(run => run.cacheWriteTokens)) },
    byAgent: group(runs, run => run.agent || "Unknown"),
    byRepo: group(runs, run => run.repo),
    cardStatus: [...statusCounts].map(([status, count]) => ({ status, count })),
  };
}
