import assert from "node:assert/strict";
import test from "node:test";
import type { Card } from "../src/model.js";
import { activityText, buildGraph, dependencyChain, stateCounts, visualState } from "../src/visualizer/graph.js";

const now = Date.parse("2026-01-01T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const card = (id: string, extra: Partial<Card> = {}) =>
  ({ id, title: id, status: "triage", turns: 0, attempts: 0, ...extra }) as Card;

test("every status maps to its visual state", () => {
  const cases: [Partial<Card>, string][] = [
    [{ status: "running", lastActivityAt: ago(1000) }, "working"],
    [{ status: "running" }, "working"],
    [{ status: "running", lastActivityAt: ago(6 * 60_000) }, "quiet"],
    [{ status: "review", reviewWait: "agent_review" }, "agent_review"],
    [{ status: "review", reviewWait: "github" }, "waiting"],
    [{ status: "review", reviewWait: "ci_fix" }, "waiting"],
    [{ status: "review" }, "needs_review"],
    [{ status: "failed" }, "failed"],
    [{ status: "interrupted" }, "interrupted"],
    [{ status: "done" }, "done"],
    [{ status: "archived" }, "done"],
    [{ status: "ready" }, "ready"],
    [{ status: "ready", blocked: true }, "blocked"],
    [{ status: "triage" }, "triage"],
    [{ status: "triage", blocked: true }, "blocked"],
  ];
  for (const [extra, want] of cases)
    assert.equal(visualState(card("a", extra), now), want, JSON.stringify(extra));
});

test("the quiet threshold is a parameter", () => {
  const c = card("a", { status: "running", lastActivityAt: ago(2000) });
  assert.equal(visualState(c, now, 1000), "quiet");
  assert.equal(visualState(c, now, 5000), "working");
});

test("activity text", () => {
  const dep = (id: string, status: Card["status"]) => card(id, { status });
  const blocked = card("b", { status: "ready", blocked: true, dependsOn: ["x", "y", "z", "gone"] });
  const board = [blocked, dep("x", "running"), dep("y", "triage"), dep("z", "done")];
  assert.equal(activityText(blocked, "blocked", board, now), "blocked by 2");
  const run = card("r", { status: "running", turns: 3 });
  assert.equal(activityText(run, "working", [], now, { tool: "bash", turn: 7, sinceMs: now - 12_000 }), "bash · turn 7 · 12s");
  assert.equal(activityText(run, "working", [], now), "running · turn 3");
  assert.equal(activityText(card("q", { status: "running", lastActivityAt: ago(6 * 60_000) }), "quiet", [], now), "quiet · 6m silent");
  assert.equal(activityText(card("g", { status: "review", reviewWait: "github" }), "waiting", [], now), "waiting on github");
  assert.equal(activityText(card("f", { status: "failed", attempts: 2 }), "failed", [], now), "failed · attempt 2");
  assert.equal(activityText(card("n", { status: "review" }), "needs_review", [], now), "needs your review");
  assert.equal(activityText(card("d", { status: "done" }), "done", [], now), "done");
});

test("done filter", () => {
  const cards = [
    card("used", { status: "done" }),
    card("unused", { status: "done" }),
    card("arch", { status: "archived" }),
    card("open", { status: "ready", dependsOn: ["used"] }),
    card("doneChild", { status: "done", dependsOn: ["arch"] }),
  ];
  const ids = (done?: "all" | "relevant" | "hide") =>
    buildGraph(cards, { done, now }).nodes.map((n) => n.id).sort();
  assert.deepEqual(ids(), ["open", "used"]);
  assert.deepEqual(ids("relevant"), ["open", "used"]);
  assert.deepEqual(ids("hide"), ["open"]);
  assert.equal(ids("all").length, 5);
  assert.deepEqual(buildGraph(cards, { now }).edges, [{ from: "used", to: "open" }]);
});

test("a missing dependency makes no edge", () => {
  const { nodes, edges } = buildGraph([card("a", { dependsOn: ["ghost"], blocked: true })], { now });
  assert.equal(nodes.length, 1);
  assert.deepEqual(edges, []);
});

test("a cycle and a self-dependency do not hang", () => {
  const cards = [
    card("a", { status: "ready", blocked: true, dependsOn: ["b", "a"] }),
    card("b", { status: "ready", blocked: true, dependsOn: ["a"] }),
  ];
  const { nodes, edges } = buildGraph(cards, { done: "all", now });
  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 2);
  assert.equal(activityText(cards[0], "blocked", cards, now), "blocked by 2");
});

test("a dependency chain holds every ancestor and descendant, and nothing on a side branch", () => {
  //  a → b → c → d,  a → x,  y → c
  const edges = [["a", "b"], ["b", "c"], ["c", "d"], ["a", "x"], ["y", "c"]].map(([from, to]) => ({ from, to }));
  assert.deepEqual([...dependencyChain("c", edges)].sort(), ["a", "b", "c", "d", "y"]);
  assert.deepEqual([...dependencyChain("x", edges)].sort(), ["a", "x"], "x sees its dependency, not a's other dependents");
  assert.deepEqual([...dependencyChain("solo", edges)], ["solo"]);
  assert.deepEqual([...dependencyChain("a", [{ from: "a", to: "b" }, { from: "b", to: "a" }])].sort(), ["a", "b"], "cycles end");
});

test("state counts list only the states in use", () => {
  const { nodes } = buildGraph([card("a", { status: "done" }), card("b", { status: "done" }), card("c", { status: "ready" })], { done: "all", now });
  assert.deepEqual(stateCounts(nodes), { done: 2, ready: 1 });
});
