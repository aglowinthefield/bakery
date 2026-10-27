import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { Integration } from "../server/integration.js";
import { OriginMain } from "../server/origin-main.js";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-origin-main-"));
  const repo = join(dir, "repo"), remote = join(dir, "remote.git"), data = join(dir, "data");
  mkdirSync(repo); mkdirSync(join(data, "worktrees"), { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "original\n");
  git(repo, "add", "README.md");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  const board = new Board(join(dir, "board.sqlite"));
  const repoBoard = board.addRepo(repo);
  const integration = new Integration(board, data);
  const card = board.createCard({ title: "Ship it", body: "", repo });
  board.setStatus(card.id, "ready");
  const run = board.claim(card.id), worktree = join(data, "worktrees", card.id);
  git(repo, "worktree", "add", "-qb", `bakery/${card.id}`, worktree, "HEAD");
  board.attach(run.id, process.pid, worktree);
  board.finish(run.id, "review");
  writeFileSync(join(worktree, "README.md"), "original\nreviewed\n");
  const reviewed = board.getCard(card.id)!;
  integration.approve(reviewed, integration.review(reviewed).fingerprint);
  return { dir, repo, board, card, repoBoard, close: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const state = (item: ReturnType<typeof fixture>, board = item.board.getBoard(item.repoBoard.id)!) =>
  new OriginMain(item.board).annotate(board, item.board.listCards(item.repo)).find(card => card.id === item.card.id)?.originMain;

test("a Done card on a local board with a GitHub remote says whether its merge is on origin/main as of the last fetch", () => {
  const item = fixture();
  try {
    item.board.setRemoteUrl(item.repoBoard.id, "https://github.com/acme/widgets");
    assert.equal(item.board.getCard(item.card.id)!.status, "done");
    assert.equal(state(item), "local");
    // Pushing alone does not change the answer until a fetch updates origin/main: no network on render.
    git(item.repo, "push", "-q", "origin", "main:refs/heads/main");
    git(item.repo, "update-ref", "refs/remotes/origin/main", git(item.repo, "rev-parse", "main~1"));
    assert.equal(state(item), "local");
    git(item.repo, "fetch", "-q", "origin");
    assert.equal(state(item), "pushed");
  } finally { item.close(); }
});

test("no push state without a GitHub remote, on github-pr boards, or for cards that are not Done", () => {
  const item = fixture();
  try {
    assert.equal(state(item), undefined, "origin is a local path and the board has no GitHub link");
    item.board.setRemoteUrl(item.repoBoard.id, "https://gitlab.com/acme/widgets");
    assert.equal(state(item), undefined);
    item.board.setRemoteUrl(item.repoBoard.id, "https://github.com/acme/widgets");
    assert.equal(state(item, { ...item.board.getBoard(item.repoBoard.id)!, integration: "github-pr" }), undefined);
    item.board.setStatus(item.card.id, "ready");
    assert.equal(state(item), undefined);
  } finally { item.close(); }
});
