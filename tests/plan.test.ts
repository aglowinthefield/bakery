import assert from "node:assert/strict";
import test from "node:test";
import { parsePlan } from "../src/plan.js";

const block = (json: string) => `Report\n\n\`\`\`bakery-plan\n${json}\n\`\`\`\n`;

test("a plan is ordered so dependencies come first", () => {
  const plan = parsePlan(block('[{"id":"b","title":"Wire UI","body":"Use the API","dependsOn":["a"]},{"id":"a","title":"Add API","body":"Endpoint"}]'));
  assert.deepEqual(plan && "subtasks" in plan && plan.subtasks.map(task => task.id), ["a", "b"]);
});

test("no block means no plan; bad plans name the problem", () => {
  assert.equal(parsePlan("## Summary\nDone."), null);
  const error = (json: string) => { const plan = parsePlan(block(json)); return plan && "error" in plan ? plan.error : ""; };
  assert.match(error("nope"), /not valid JSON/);
  assert.match(error("[]"), /non-empty/);
  assert.match(error('[{"id":"a","title":"t","body":"b","dependsOn":["z"]}]'), /unknown id "z"/);
  assert.match(error('[{"id":"a","title":"t","body":"b"},{"id":"a","title":"t","body":"b"}]'), /used twice/);
  assert.match(error('[{"id":"a","title":"t","body":"b","dependsOn":["b"]},{"id":"b","title":"t","body":"b","dependsOn":["a"]}]'), /cycle/);
  assert.match(error('[{"id":"a","title":"","body":"b"}]'), /needs an id/);
});
