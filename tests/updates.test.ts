import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updates, promoteStagedUi } from "../server/updates.js";

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
    assert.equal(updates.state.commits.length, 2, "still pending until the server restarts on them");
    const restarted = new Updates(repo, async () => {}, () => {});
    restarted.refresh();
    assert.deepEqual(restarted.state.commits, []);
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

// Approving a card merges its branch into the checkout's own main with a "Merge card:" commit, so HEAD moves while
// origin/main stays put.
function mergeLocally(repo: string, subject: string) {
  git(repo, "checkout", "-q", "-b", "card");
  git(repo, "commit", "-q", "--allow-empty", "-m", `Bakery card: ${subject}`);
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", `Merge card: ${subject}`, "card");
  git(repo, "branch", "-q", "-D", "card");
}

test("lists commits merged into main since startup, after any from origin/main", () => {
  const { repo, close } = fixture();
  try {
    git(repo, "merge", "-q", "--ff-only", "origin/main");
    const updates = new Updates(repo, async () => {}, () => {});
    updates.refresh();
    assert.equal(updates.state.commits.length, 0);
    mergeLocally(repo, "Approved card");
    updates.refresh();
    assert.deepEqual(updates.state.commits.map(commit => commit.subject), ["Bakery card: Approved card"], "the card once, without its merge commit");
  } finally { close(); }
});

test("combines origin/main updates with local merges, newest first", () => {
  const { repo, close } = fixture();
  try {
    const updates = new Updates(repo, async () => {}, () => {});
    mergeLocally(repo, "Approved card");
    updates.refresh();
    assert.deepEqual(updates.state.commits.map(commit => commit.subject), ["Fix typo", "Add pending updates notice", "Bakery card: Approved card"]);
  } finally { close(); }
});

// The install builds into dist-next so a draining server keeps serving the UI that matches its API.
test("a restarted server swaps the staged UI build into dist", () => {
  const root = mkdtempSync(join(tmpdir(), "bakery-ui-"));
  try {
    assert.equal(promoteStagedUi(root), false);
    mkdirSync(join(root, "dist", "assets"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "old");
    writeFileSync(join(root, "dist", "assets", "old.js"), "old");
    mkdirSync(join(root, "dist-next"));
    writeFileSync(join(root, "dist-next", "index.html"), "new");
    assert.equal(promoteStagedUi(root), true);
    assert.equal(readFileSync(join(root, "dist", "index.html"), "utf8"), "new");
    assert.equal(existsSync(join(root, "dist", "assets", "old.js")), false);
    assert.equal(existsSync(join(root, "dist-next")), false);
    assert.equal(promoteStagedUi(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
