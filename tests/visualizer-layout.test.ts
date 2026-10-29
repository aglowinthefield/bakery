import assert from "node:assert/strict";
import test from "node:test";
import ELK from "elkjs/lib/elk.bundled.js";
import { layoutGraph, layoutKey } from "../src/visualizer/layout.js";
import { buildLook, mixHex } from "../src/visualizer/look.js";

test("layout runs left to right and places every node", async () => {
  const elk = new ELK();
  const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "d" }];
  const pos = await layoutGraph(elk, ["a", "b", "c", "d", "lone"], edges);
  assert.equal(pos.size, 5);
  assert.ok(pos.get("a")!.x < pos.get("b")!.x && pos.get("b")!.x < pos.get("c")!.x);
  assert.ok(pos.get("a")!.x < pos.get("d")!.x);
  assert.notDeepEqual(pos.get("b"), pos.get("d"));
});

test("a dependency cycle still lays out", async () => {
  const pos = await layoutGraph(new ELK(), ["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }]);
  assert.equal(pos.size, 2);
});

test("the layout key changes only with the node or edge set", () => {
  const e = [{ from: "a", to: "b" }];
  assert.equal(layoutKey(["a", "b"], e), layoutKey(["b", "a"], [...e]));
  assert.notEqual(layoutKey(["a", "b"], e), layoutKey(["a", "b"], []));
  assert.notEqual(layoutKey(["a", "b"], e), layoutKey(["a", "b", "c"], e));
});

test("the look reads each state's color from theme variables and follows the theme type", () => {
  const vars: Record<string, string> = {
    "--background": "#101010", "--foreground": "#eeeeee", "--border": "#333333", "--repo-sky": "#0000ff",
    "--status-triage": "#000000", "--status-ready": "#111111", "--status-running": "#222222", "--status-review": "#333333",
    "--status-failed": "#ffffff", "--status-interrupted": "#555555", "--status-done": "#666666", "--status-archived": "#777777",
  };
  const look = buildLook(name => vars[name], "default");
  assert.equal(look.light, false);
  assert.equal(buildLook(name => vars[name], "compline-light").light, true);
  assert.equal(look.colors.working, "#222222");
  assert.equal(look.colors.waiting, "#0000ff");
  assert.equal(look.colors.agent_review, "#777777");
  assert.equal(look.colors.quiet, vars["--status-interrupted"]);
  assert.equal(look.colors.blocked, mixHex("#ffffff", "#000000", 0.35));
  assert.equal(look.background, "#101010");
});
