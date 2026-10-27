import { test } from "node:test";
import assert from "node:assert/strict";
import { filterPullRequests, noFilters, sortPullRequests, type PullRequest } from "../src/pull-request-filter.js";

const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  number, title: `PR ${number}`, url: "", headRefName: `b${number}`, isDraft: false,
  updatedAt: `2025-01-0${number}T00:00:00Z`, createdAt: `2025-01-0${10 - number}T00:00:00Z`, ...extra,
});
const pulls = [
  pr(1, { author: { login: "ana" }, labels: [{ name: "bug" }], reviewDecision: "APPROVED", checks: "passing", mergeable: "MERGEABLE", additions: 5, deletions: 5 }),
  pr(2, { author: { login: "bo" }, mergeable: "CONFLICTING", isDraft: true, assignees: [{ login: "ana" }], additions: 100, card: { id: "c", title: "t", status: "review", prChecks: null } }),
  pr(3, { author: { login: "ana" }, title: "Fix login", checks: "failing" }),
];
const numbers = (list: PullRequest[]) => list.map((item) => item.number);

test("filters combine like GitHub's list filters", () => {
  assert.deepEqual(numbers(filterPullRequests(pulls, { ...noFilters, author: "ana" })), [1, 3]);
  assert.deepEqual(numbers(filterPullRequests(pulls, { ...noFilters, author: "ana", checks: "failing" })), [3]);
  assert.deepEqual(numbers(filterPullRequests(pulls, { ...noFilters, draft: "draft" })), [2]);
  assert.deepEqual(numbers(filterPullRequests(pulls, { ...noFilters, card: "without" })), [1, 3]);
  assert.deepEqual(numbers(filterPullRequests(pulls, { ...noFilters, conflicts: "conflicting" })), [2]);
  assert.deepEqual(numbers(filterPullRequests(pulls, { ...noFilters, conflicts: "clean" })), [1]);
  assert.deepEqual(numbers(filterPullRequests(pulls, { ...noFilters, review: "none" })), [2, 3]);
  assert.deepEqual(numbers(filterPullRequests(pulls, { ...noFilters, assignee: "none" })), [1, 3]);
});

test("search takes free words and key:value qualifiers", () => {
  const find = (query: string) => numbers(filterPullRequests(pulls, { ...noFilters, query }));
  assert.deepEqual(find("login"), [3]);
  assert.deepEqual(find("author:ana label:bug"), [1]);
  assert.deepEqual(find("is:draft"), [2]);
  assert.deepEqual(find("is:conflicting"), [2]);
  assert.deepEqual(find("#2"), [2]);
  assert.deepEqual(find("assignee:ana"), [2]);
});

test("sorts by created, updated and size", () => {
  assert.deepEqual(numbers(sortPullRequests(pulls, "newest")), [1, 2, 3]);
  assert.deepEqual(numbers(sortPullRequests(pulls, "oldest")), [3, 2, 1]);
  assert.deepEqual(numbers(sortPullRequests(pulls, "updated")), [3, 2, 1]);
  assert.deepEqual(numbers(sortPullRequests(pulls, "largest")), [2, 1, 3]);
});
