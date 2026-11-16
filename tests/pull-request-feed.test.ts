import assert from "node:assert/strict";
import test from "node:test";
import { PullRequestFeed } from "../server/pull-request-feed.js";

test("a failed pull request list rejects its callers without an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", record);
  try {
    const board = { getBoard: () => ({ id: "b", repo: "/r", remoteUrl: "https://github.com/o/r.git" }) };
    const github = { listOpenPullRequests: async () => { throw new Error("gh is not signed in"); } };
    const feed = new PullRequestFeed(board as never, github as never);
    await assert.rejects(feed.refresh("b"), /gh is not signed in/);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", record); }
});
