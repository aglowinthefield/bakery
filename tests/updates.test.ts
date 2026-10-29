import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updates } from "../server/updates.js";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8" }).trim();
}

// A checkout whose origin/main is two commits ahead, as after the update timer fetched.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-updates-"));
  const repo = join(dir, "repo"), remote = join(dir, "remote.git"), other = join(dir, "other");
  mkdirSync(repo);
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "one\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "Initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", remote, other);
  for (const subject of ["Add pending updates notice", "Fix typo"]) git(other, "commit", "-q", "--allow-empty", "-m", subject);
  git(other, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  return { repo, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("lists the fetched commits newest first as the changelog", () => {
  const { repo, close } = fixture();
  try {
    const updates = new Updates(repo, async () => {}, () => {});
    updates.refresh();
    assert.deepEqual(updates.state.commits.map(commit => commit.subject), ["Fix typo", "Add pending updates notice"]);
    git(repo, "merge", "-q", "--ff-only", "origin/main");
    updates.refresh();
    assert.deepEqual(updates.state.commits, []);
  } finally { close(); }
});

test("installs by itself only while idle, then hands over to restart", async () => {
  const { repo, close } = fixture();
  try {
    let installs = 0, restarts = 0;
    const updates = new Updates(repo, async () => { installs++; }, () => { restarts++; });
    await updates.tick(false);
    assert.equal(installs, 0);
    await updates.tick(true);
    assert.deepEqual([installs, restarts], [1, 1]);
  } finally { close(); }
});

test("a failed install shows its error and is not retried automatically until origin/main moves", async () => {
  const { repo, close } = fixture();
  try {
    let installs = 0, restarts = 0;
    const updates = new Updates(repo, async () => { installs++; throw new Error("Not possible to fast-forward, aborting."); }, () => { restarts++; });
    await updates.tick(true);
    await updates.tick(true);
    assert.deepEqual([installs, restarts], [1, 0]);
    assert.deepEqual([updates.state.installing, updates.state.error], [false, "Not possible to fast-forward, aborting."]);
    await updates.apply();
    assert.equal(installs, 2, "the button still retries");
  } finally { close(); }
});

test("asking to install with nothing pending is refused", () => {
  const { repo, close } = fixture();
  try {
    git(repo, "merge", "-q", "--ff-only", "origin/main");
    const updates = new Updates(repo, async () => {}, () => {});
    assert.throws(() => updates.apply(), /Already up to date/);
  } finally { close(); }
});
