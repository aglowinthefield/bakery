import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStats, parseTime, type StatsInput } from "../server/stats.js";

const now = Date.parse("2026-03-10T12:00:00.000Z");
const run = (over: Partial<StatsInput["runs"][number]>): StatsInput["runs"][number] => ({
  repo: "/code/alpha", cardId: "c1", status: "review", startedBy: "manual", agent: "pi · sonnet", ciFix: 0,
  startedAt: "2026-03-10T10:00:00.000Z", finishedAt: "2026-03-10T10:10:00.000Z",
  cost: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, ...over,
});
const input: StatsInput = {
  runs: [
    run({}),
    run({ status: "failed", startedBy: "auto", cost: 0.5, finishedAt: "2026-03-10T10:20:00.000Z" }),
    run({ repo: "/code/beta", agent: "pi · opus", startedAt: "2026-03-09 08:00:00", finishedAt: "2026-03-09 09:00:00", cost: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }),
    run({ startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:05:00.000Z", cost: 10 }),
    run({ status: "running", cost: 99 }),
  ],
  reviews: [{ repo: "/code/alpha", state: "merged", agent: "pi", startedAt: "2026-03-10T11:00:00.000Z", finishedAt: null, cost: 0.25 }],
  cards: [
    { repo: "/code/alpha", status: "done", createdAt: "2026-03-09T12:00:00.000Z", updatedAt: "2026-03-10T00:00:00.000Z", attempts: 2, reviewRounds: 1, ciReworks: 2 },
    { repo: "/code/beta", status: "triage", createdAt: "2026-03-10T01:00:00.000Z", updatedAt: "2026-03-10T01:00:00.000Z", attempts: 0, reviewRounds: 0, ciReworks: 0 },
  ],
};

test("SQLite timestamps without a zone read as UTC", () => {
  assert.equal(parseTime("2026-03-09 08:00:00"), Date.parse("2026-03-09T08:00:00Z"));
  assert.equal(parseTime(null), null);
});

test("summary covers the range and skips running runs", () => {
  const stats = buildStats(input, { days: 7, repo: null, now });
  assert.equal(stats.summary.runs, 3);
  assert.equal(stats.summary.cost, 1 + 0.5 + 0.25);
  assert.equal(stats.summary.successRate, 2 / 3);
  assert.equal(stats.summary.autoShare, 1 / 3);
  assert.equal(stats.summary.cardsCreated, 2);
  assert.equal(stats.summary.cardsDone, 1);
  assert.equal(stats.summary.avgLeadHours, 12);
  assert.equal(stats.summary.agentReviewsMerged, 1);
  assert.equal(stats.tokens.input, 200);
});

test("all time includes older runs and starts at the first record", () => {
  const stats = buildStats(input, { days: null, repo: null, now });
  assert.equal(stats.summary.runs, 4);
  assert.equal(stats.daily[0].date, "2026-01-01");
  assert.equal(stats.daily.at(-1)?.date, "2026-03-10");
});

test("daily buckets fill the window and split outcomes", () => {
  const stats = buildStats(input, { days: 7, repo: null, now });
  assert.equal(stats.daily.length, 7);
  const today = stats.daily.at(-1)!;
  assert.deepEqual([today.date, today.succeeded, today.failed, today.cost], ["2026-03-10", 1, 1, 1.75]);
  assert.equal(stats.daily.find(point => point.date === "2026-03-09")?.succeeded, 1);
});

test("repo filter narrows runs and cards; groups sort by spend", () => {
  const alpha = buildStats(input, { days: 7, repo: "/code/alpha", now });
  assert.equal(alpha.summary.runs, 2);
  assert.equal(alpha.summary.cardsCreated, 1);
  const all = buildStats(input, { days: 7, repo: null, now });
  assert.deepEqual(all.byRepo.map(row => row.name), ["/code/alpha", "/code/beta"]);
  assert.equal(all.byAgent.find(row => row.name === "pi · sonnet")?.failed, 1);
});

test("an empty range reports unknowns instead of zeros", () => {
  const stats = buildStats({ runs: [], reviews: [], cards: [] }, { days: 30, repo: null, now });
  assert.equal(stats.summary.successRate, null);
  assert.equal(stats.summary.avgRunMinutes, null);
  assert.equal(stats.daily.length, 30);
});
