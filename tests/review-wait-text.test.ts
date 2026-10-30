import assert from "node:assert/strict";
import { test } from "node:test";
import { cardActivity, reviewWaitText, type Card } from "../src/model.js";

const card = (extra: Partial<Card>) => ({ status: "review", ...extra }) as Card;

test("a queued agent review says where it stands and counts as waiting, a started one as working", () => {
  const queued = card({ reviewWait: "agent_review", reviewQueue: { position: 4, of: 11 } });
  assert.equal(reviewWaitText(queued), "Waiting for agent review (#4 of 11)");
  assert.equal(cardActivity(queued), "waiting");
  const started = card({ reviewWait: "agent_review", reviewQueue: null });
  assert.equal(reviewWaitText(started), "Agent reviewing");
  assert.equal(cardActivity(started), "working");
  assert.equal(reviewWaitText(card({ reviewWait: "github" })), "Waiting on GitHub");
});
