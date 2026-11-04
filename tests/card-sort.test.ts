import assert from "node:assert/strict";
import { test } from "node:test";
import { isCardSort, sortCards } from "../src/model.js";

const c = (title: string, priority: number, createdAt: string, updatedAt: string) => ({
  title, priority, createdAt, updatedAt,
});
const cards = [
  c("b", 0, "2026-01-02", "2026-01-05"),
  c("a", 50, "2026-01-01", "2026-01-03"),
  c("C", 0, "2026-01-03", "2026-01-04"),
];
const titles = (sort: Parameters<typeof sortCards>[1]) => sortCards(cards, sort).map(x => x.title).join("");

test("sortCards orders by each key and leaves the input alone", () => {
  assert.equal(titles("priority"), "abC");
  assert.equal(titles("updated"), "bCa");
  assert.equal(titles("newest"), "Cba");
  assert.equal(titles("oldest"), "abC");
  assert.equal(titles("title"), "abC");
  assert.equal(cards[0].title, "b");
});

test("equal keys fall back to priority", () => {
  const tied = [c("x", 0, "2026-01-01", "2026-01-01"), c("y", 9, "2026-01-01", "2026-01-01")];
  assert.equal(sortCards(tied, "updated").map(x => x.title).join(""), "yx");
});

test("isCardSort rejects unknown values", () => {
  assert.ok(isCardSort("updated"));
  assert.ok(!isCardSort("toString"));
  assert.ok(!isCardSort(null));
});
