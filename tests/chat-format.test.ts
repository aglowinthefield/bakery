import { test } from "node:test";
import assert from "node:assert/strict";
import { chatLabel, dayHeading, fewWords, fullTime, groupByDate, readGrouping, shortDay, shortTime } from "../src/chat-format.js";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const now = new Date(2025, 5, 15, 18, 0);

test("sidebar labels are a few words, whatever the chat holds", () => {
  assert.equal(chatLabel({ topic: "Card B waiting", title: "long" }), "Card B waiting");
  assert.equal(chatLabel({ topic: "", title: "Why is card B still waiting after A finished yesterday afternoon?" }), "Why is card B still…");
  assert.equal(chatLabel({ topic: "One two three four five six seven eight", title: "x" }), "One two three four five six…");
  assert.equal(chatLabel({ topic: "", title: "" }), "New chat");
  assert.equal(chatLabel({ topic: "", title: "Short title" }), "Short title");
  assert.ok(fewWords("Supercalifragilisticexpialidocious-".repeat(5), 5).length <= 41, "one very long word is cut by length");
  assert.equal(fewWords("## Plan the auth refactor\nsecond line", 5), "Plan the auth refactor");
});

test("timestamps are local, compact, and carry the full date in the tooltip text", () => {
  const today = at(2025, 6, 15, 9, 5);
  assert.equal(shortTime(today, now, "en-US"), "9:05 AM");
  assert.equal(shortTime(at(2025, 6, 14, 21, 30), now, "en-US"), "Jun 14, 9:30 PM");
  assert.equal(shortTime(at(2024, 12, 31, 8, 0), now, "en-US"), "Dec 31, 2024, 8:00 AM");
  assert.equal(shortDay(today, now, "en-US"), "9:05 AM");
  assert.equal(shortDay(at(2025, 6, 1), now, "en-US"), "Jun 1");
  const full = fullTime(today, "en-US");
  assert.match(full, /Sunday, June 15, 2025/);
  assert.match(full, /9:05\s?AM/);
});

test("date grouping orders days and chats newest first under day headings", () => {
  const chats = [
    { id: "old", updatedAt: at(2025, 6, 10) },
    { id: "t1", updatedAt: at(2025, 6, 15, 8) },
    { id: "y", updatedAt: at(2025, 6, 14, 23) },
    { id: "t2", updatedAt: at(2025, 6, 15, 17) },
  ];
  const groups = groupByDate(chats, now, "en-US");
  assert.deepEqual(groups.map(g => g.heading), ["Today", "Yesterday", "Tue, Jun 10"]);
  assert.deepEqual(groups.map(g => g.chats.map(c => c.id)), [["t2", "t1"], ["y"], ["old"]]);
  assert.equal(dayHeading(new Date(2024, 0, 2), now, "en-US"), "Tue, Jan 2, 2024");
  assert.deepEqual(groupByDate([], now), []);
});

test("a saved grouping reads back; anything else means no grouping", () => {
  assert.equal(readGrouping("date"), "date");
  assert.equal(readGrouping("none"), "none");
  assert.equal(readGrouping(null), "none");
  assert.equal(readGrouping("author"), "none");
});
