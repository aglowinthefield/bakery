import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { Discord } from "../server/discord.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-discord-")), repo = join(dir, "repo");
  mkdirSync(repo); execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  const board = new Board(join(dir, "board.sqlite")); board.addRepo(repo);
  const run = (status: "review" | "failed" | "interrupted") => {
    const card = board.createCard({ repo, title: "Add a new line", body: "" });
    board.setStatus(card.id, "ready");
    const r = board.claim(card.id); board.finish(r.id, status as "review", status === "failed" ? "boom" : undefined);
  };
  return { board, run, close: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("posts review and failed runs, skips stopped ones", async () => {
  const { board, run, close } = fixture(), posts: { url: string; body: any }[] = [];
  new Discord(board, "https://discord.test/hook", async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 204 }; });
  run("review"); run("failed"); run("interrupted");
  await new Promise(r => setTimeout(r, 50));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].url, "https://discord.test/hook");
  assert.match(posts[0].body.embeds[0].title, /^Ready for review: Add a new line/);
  assert.match(posts[1].body.embeds[0].title, /^Run failed/);
  assert.equal(posts[1].body.embeds[0].description, "boom");
  assert.deepEqual(posts[1].body.allowed_mentions, { parse: [] });
  close();
});

test("does nothing without a webhook URL", async () => {
  const { board, run, close } = fixture();
  let called = false;
  new Discord(board, undefined, async () => { called = true; return { ok: true, status: 204 }; });
  run("review"); await new Promise(r => setTimeout(r, 50));
  assert.equal(called, false); close();
});
