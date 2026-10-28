import assert from "node:assert/strict";
import test from "node:test";
import { followUps } from "../src/follow-ups.js";

test("follow-ups reads bullets under the Follow-ups heading only", () => {
  const report = "## Summary\n- changed a thing\n\n## Follow-ups\n- **Run the backfill** `scripts/backfill.ts` against prod\n  once the deploy lands\n- Add an index on `cards.repo`\n\n## Notes\n- not a follow-up";
  assert.deepEqual(followUps(report), [
    { title: "Run the backfill scripts/backfill.ts against prod", body: "**Run the backfill** `scripts/backfill.ts` against prod\nonce the deploy lands" },
    { title: "Add an index on cards.repo", body: "Add an index on `cards.repo`" },
  ]);
  assert.deepEqual(followUps("## Summary\n- nothing else"), []);
  assert.deepEqual(followUps("## Follow-ups\nNone."), []);
});
