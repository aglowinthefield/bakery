import assert from "node:assert/strict";
import test from "node:test";
import { formatRoute, parseRoute, type Route } from "../src/route.js";

const routes: Route[] = [
  { view: "today", boardId: null, cardId: null },
  { view: "stats", boardId: null, cardId: null },
  { view: "logs", boardId: null, cardId: null },
  { view: "board", boardId: "b1", cardId: null },
  { view: "pulls", boardId: "b1", cardId: null },
  { view: "board", boardId: "b 1", cardId: "c/2" },
];

test("routes round-trip through their path", () => {
  for (const route of routes)
    assert.deepEqual(parseRoute(formatRoute(route)), route);
});

test("unknown paths are not routes", () => {
  assert.equal(parseRoute("/"), null, "/ opens the screen viewed last");
  assert.equal(parseRoute("/nope"), null);
  assert.equal(parseRoute("/board"), null);
  assert.equal(parseRoute("/board/b1/card"), null);
});
