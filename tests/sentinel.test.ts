import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Board } from "../server/board.js";
import type { GitHub } from "../server/github.js";
import { lockBody, lockStatus, lockTtlMs, parseLock } from "../server/pr-lock.js";
import { PrLocks } from "../server/pr-locks.js";
import { RunLocks } from "../server/run-locks.js";
import { Sentinel, maxOpenSentinelCards, maxSentinelAttempts, sentinelBrief } from "../server/sentinel.js";
import { SentinelStore } from "../server/sentinel-store.js";

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("a lock comment round-trips and expires after 30 minutes", () => {
  const lock = { holder: "card-1", startedAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(parseLock(lockBody(lock)), lock);
  const start = Date.parse(lock.startedAt);
  assert.equal(lockStatus(lock, start + lockTtlMs - 1), "active");
  assert.equal(lockStatus(lock, start + lockTtlMs), "expired");
  const released = { ...lock, releasedAt: "2026-01-01T00:05:00.000Z" };
  assert.deepEqual(parseLock(lockBody(released)), released);
  assert.equal(lockStatus(released, start + 10 * lockTtlMs), "released");
  assert.equal(parseLock("just a comment"), undefined);
  assert.equal(parseLock("<!-- bakery-lock {nope} -->"), undefined);
});

type Pr = { number: number; title: string; url: string; author: { login: string }; isDraft: boolean; mergeable: string; failing?: boolean; state: string; headRefOid: string; headRefName: string };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakery-sentinel-"));
  const origin = join(dir, "origin.git"), repo = join(dir, "repo"), upstream = join(dir, "upstream");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, upstream], { stdio: "ignore" });
  git(upstream, "checkout", "-q", "-b", "main");
  writeFileSync(join(upstream, "a.txt"), "a\n");
  git(upstream, "add", "a.txt"); git(upstream, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"); git(upstream, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
  const board = new Board(join(dir, "board.sqlite"));
  const repoBoard = board.addRepo(repo);
  board.setRemoteUrl(repoBoard.id, "https://github.com/acme/widgets");
  board.setIntegration(repoBoard.id, "github-pr");
  const prs: Pr[] = [];
  const comments = new Map<number, { id: string; body: string; author: string }[]>();
  let nextComment = 1;
  const github = {
    viewer: async () => "aglowinthefield",
    listOpenPullRequests: async () => prs.filter(pr => pr.state === "OPEN"),
    health: async (_repo: string, number: number) => { const pr = prs.find(item => item.number === number)!; return { mergeable: pr.mergeable, statusCheckRollup: pr.failing ? [{ name: "test", conclusion: "FAILURE" }] : [] }; },
    view: async (_repo: string, number: number) => prs.find(pr => pr.number === number)!,
    listComments: async (_repo: string, number: number) => [...(comments.get(number) ?? [])],
    createComment: async (_repo: string, number: number, body: string) => { const id = String(nextComment++); comments.set(number, [...(comments.get(number) ?? []), { id, body, author: "bakery" }]); return id; },
    editComment: async (_repo: string, id: string, body: string) => { for (const list of comments.values()) for (const item of list) if (item.id === id) item.body = body; },
    comment: async (_repo: string, number: number, body: string) => { comments.set(number, [...(comments.get(number) ?? []), { id: String(nextComment++), body, author: "bakery" }]); },
  } as unknown as GitHub;
  const store = new SentinelStore(board.sqlite);
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const locks = new PrLocks(store, github, () => clock);
  const sentinel = new Sentinel(board, github, store, locks, join(dir, "data"), "aglowinthefield");
  let n = 100;
  const addPr = (over: Partial<Pr> = {}): Pr => { const number = n++; const pr = { number, title: `Change ${number}`, url: `https://github.com/acme/widgets/pull/${number}`, author: { login: "aglowinthefield" }, isDraft: false, mergeable: "CONFLICTING", state: "OPEN", headRefOid: `head${number}`.padEnd(40, "0"), headRefName: `feature-${number}`, ...over }; prs.push(pr); return pr; };
  const sentinelCards = () => board.listCards(repo).filter(card => card.title.startsWith("Fix PR #"));
  const land = (name: string) => { git(upstream, "pull", "-q", "--ff-only", "origin", "main"); writeFileSync(join(upstream, name), name); git(upstream, "add", name); git(upstream, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", name); git(upstream, "push", "-q", "origin", "main"); };
  return { dir, origin, upstream, github, board, repoBoard, repo, store, locks, sentinel, addPr, prs, comments, sentinelCards, land, advance: (ms: number) => { clock += ms; }, cleanup: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a conflicting PR by the owner gets a Ready card whose brief rebases onto main first, and a lock", async () => {
  const f = fixture();
  try {
    const pr = f.addPr();
    await f.sentinel.pass(f.repoBoard.id);
    const [card] = f.sentinelCards();
    assert.equal(card.status, "ready");
    assert.match(card.body, /It conflicts with main/);
    assert.ok(card.body.indexOf("rebase origin/main") < card.body.indexOf("Only now look at CI"));
    const lock = parseLock(f.comments.get(pr.number)![0].body);
    assert.equal(lock?.holder, `sentinel:${card.id}`);
    await f.sentinel.pass(f.repoBoard.id);
    assert.equal(f.sentinelCards().length, 1, "a second pass adds nothing");
  } finally { f.cleanup(); }
});

test("it leaves alone other authors' PRs, drafts, mergeable green PRs and PRs with a live lock", async () => {
  const f = fixture();
  try {
    f.addPr({ author: { login: "someone" } });
    f.addPr({ isDraft: true });
    f.addPr({ mergeable: "MERGEABLE" });
    const locked = f.addPr();
    await f.locks.acquire("acme/widgets", locked.number, "card-x");
    await f.sentinel.pass(f.repoBoard.id);
    assert.equal(f.sentinelCards().length, 0);
    f.advance(lockTtlMs + 1);
    await f.sentinel.pass(f.repoBoard.id);
    assert.equal(f.sentinelCards().length, 1, "an expired lock no longer protects the PR");
  } finally { f.cleanup(); }
});

test("a released lock does not block, and failing CI alone counts", async () => {
  const f = fixture();
  try {
    const pr = f.addPr({ mergeable: "MERGEABLE", failing: true });
    await f.locks.acquire("acme/widgets", pr.number, "card-x");
    await f.locks.release("acme/widgets", pr.number, "card-x");
    await f.sentinel.pass(f.repoBoard.id);
    const [card] = f.sentinelCards();
    assert.match(card.body, /CI is failing: test/);
  } finally { f.cleanup(); }
});

test("it stops after three attempts on one PR and says so once", async () => {
  const f = fixture();
  try {
    const pr = f.addPr();
    for (let i = 0; i < maxSentinelAttempts + 2; i++) {
      await f.sentinel.pass(f.repoBoard.id);
      for (const card of f.sentinelCards()) if (card.status === "ready") f.board.setStatus(card.id, "done");
      f.land(`m${i}.txt`);
      f.advance(lockTtlMs + 1);
    }
    assert.equal(f.sentinelCards().length, maxSentinelAttempts);
    assert.equal(f.comments.get(pr.number)!.filter(item => /tried 3 times/.test(item.body)).length, 1);
  } finally { f.cleanup(); }
});

test("it caps open sentinel cards per board", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < maxOpenSentinelCards + 3; i++) f.addPr();
    await f.sentinel.pass(f.repoBoard.id);
    assert.equal(f.sentinelCards().length, maxOpenSentinelCards);
  } finally { f.cleanup(); }
});

test("an unstarted card is withdrawn once its PR is merged, closed or mergeable again", async () => {
  const f = fixture();
  try {
    const a = f.addPr(), b = f.addPr();
    await f.sentinel.pass(f.repoBoard.id);
    a.state = "MERGED"; b.mergeable = "MERGEABLE";
    await f.sentinel.pass(f.repoBoard.id);
    assert.deepEqual(f.sentinelCards().map(card => card.status), ["done", "done"]);
    assert.match(f.comments.get(a.number)![0].body, /released/);
  } finally { f.cleanup(); }
});

test("a pending lock row left by a crash is settled from the PR", async () => {
  const f = fixture();
  try {
    f.store.beginLock("acme/widgets", 1, "card-a", "2026-01-01T00:00:00.000Z");
    await f.locks.reconcile();
    assert.equal(f.store.getLock("acme/widgets", 1), undefined, "no comment was posted, so the row is dropped");
    await f.locks.acquire("acme/widgets", 2, "card-b");
    f.store.beginLock("acme/widgets", 2, "card-c", "2026-01-01T00:01:00.000Z");
    await f.locks.reconcile();
    assert.equal(f.store.getLock("acme/widgets", 2)?.state, "held");
    assert.equal(parseLock(f.comments.get(2)![0].body)?.holder, "card-c", "the comment was brought in line with the row");
  } finally { f.cleanup(); }
});

test("the brief names the branch and leaves the push to Bakery", () => {
  const brief = sentinelBrief({ repo: "acme/widgets", number: 5, url: "u", branch: "feat", head: "a".repeat(40), mainTip: "b".repeat(40), problems: ["It conflicts with main."] });
  assert.match(brief, /git switch -C feat origin\/feat/);
  assert.match(brief, /Bakery force-pushes it/);
});

test("a run locks its card's PR while it works, and releases it when it finishes", async () => {
  const f = fixture();
  try {
    const runLocks = new RunLocks(f.board, f.locks, f.store);
    const pr = f.addPr({ mergeable: "MERGEABLE" });
    const card = f.board.createCard({ title: "Feature", body: "x", repo: f.repo });
    f.board.setStatus(card.id, "ready");
    f.board.recordPullRequest(card.id, { number: pr.number, url: pr.url, state: "OPEN" });
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));
    const run = f.board.claim(card.id);
    await settle();
    assert.equal(lockStatus(parseLock(f.comments.get(pr.number)![0].body)!, Date.parse("2026-01-01T00:01:00Z")), "active");
    f.board.finish(run.id, "review");
    await settle();
    assert.match(f.comments.get(pr.number)![0].body, /released/);
    assert.equal(f.comments.get(pr.number)!.length, 1, "the same comment is edited, not duplicated");
    runLocks.shutdown();
  } finally { f.cleanup(); }
});

test("after a sentinel run Bakery pushes the rebased branch with a lease", async () => {
  const f = fixture();
  try {
    const commit = ["-c", "user.name=t", "-c", "user.email=t@t"];
    git(f.upstream, "checkout", "-q", "-b", "feat"); writeFileSync(join(f.upstream, "f.txt"), "f"); git(f.upstream, "add", "f.txt"); git(f.upstream, ...commit, "commit", "-q", "-m", "feat"); git(f.upstream, "push", "-q", "origin", "feat");
    const head = git(f.upstream, "rev-parse", "HEAD");
    git(f.upstream, "checkout", "-q", "main"); f.land("main2.txt");
    const pr = f.addPr({ headRefName: "feat", headRefOid: head });
    await f.sentinel.pass(f.repoBoard.id);
    const [card] = f.sentinelCards();
    const worktree = join(f.dir, "data", "worktrees", card.id);
    execFileSync("git", ["clone", "-q", f.origin, worktree]);
    git(worktree, "switch", "-q", "-C", "feat", "origin/feat"); git(worktree, ...commit, "rebase", "-q", "origin/main");
    const run = f.board.claim(card.id);
    f.board.finish(run.id, "review");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.notEqual(git(worktree, "ls-remote", "origin", "refs/heads/feat").split("\t")[0], head, "the branch moved");
    assert.equal(f.board.getCard(card.id)?.status, "done");
    assert.match(f.comments.get(pr.number)!.map(item => item.body).join("\n"), /rebased this pull request onto the latest main and pushed/);
  } finally { f.cleanup(); }
});

test("a sentinel run that changes nothing puts its report on the PR instead of pushing", async () => {
  const f = fixture();
  try {
    const pr = f.addPr();
    await f.sentinel.pass(f.repoBoard.id);
    const [card] = f.sentinelCards();
    const run = f.board.claim(card.id);
    f.board.finish(run.id, "review");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.match(f.comments.get(pr.number)!.map(item => item.body).join("\n"), /could not push its fix: the card worktree is missing/);
    assert.equal(f.board.getCard(card.id)?.status, "review");
  } finally { f.cleanup(); }
});

test("the push is refused when someone pushed to the PR branch after the card was made", async () => {
  const f = fixture();
  try {
    const commit = ["-c", "user.name=t", "-c", "user.email=t@t"];
    git(f.upstream, "checkout", "-q", "-b", "feat"); writeFileSync(join(f.upstream, "f.txt"), "f"); git(f.upstream, "add", "f.txt"); git(f.upstream, ...commit, "commit", "-q", "-m", "feat"); git(f.upstream, "push", "-q", "origin", "feat");
    const head = git(f.upstream, "rev-parse", "HEAD");
    git(f.upstream, "checkout", "-q", "main"); f.land("main2.txt");
    const pr = f.addPr({ headRefName: "feat", headRefOid: head });
    await f.sentinel.pass(f.repoBoard.id);
    const [card] = f.sentinelCards();
    const worktree = join(f.dir, "data", "worktrees", card.id);
    execFileSync("git", ["clone", "-q", f.origin, worktree]);
    git(worktree, "switch", "-q", "-C", "feat", "origin/feat"); git(worktree, ...commit, "rebase", "-q", "origin/main");
    git(f.upstream, "checkout", "-q", "feat"); writeFileSync(join(f.upstream, "g.txt"), "g"); git(f.upstream, "add", "g.txt"); git(f.upstream, ...commit, "commit", "-q", "-m", "person"); git(f.upstream, "push", "-q", "origin", "feat");
    const theirs = git(f.upstream, "rev-parse", "HEAD");
    const run = f.board.claim(card.id);
    f.board.finish(run.id, "review");
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(git(worktree, "ls-remote", "origin", "refs/heads/feat").split("\t")[0], theirs, "the person's push survives");
    assert.match(f.comments.get(pr.number)!.map(item => item.body).join("\n"), /could not push its fix/);
    assert.equal(f.board.getCard(card.id)?.status, "review");
  } finally { f.cleanup(); }
});

test("when main moves during the run, Bakery rebases the result onto it and still pushes", async () => {
  const f = fixture();
  try {
    const commit = ["-c", "user.name=t", "-c", "user.email=t@t"];
    git(f.upstream, "checkout", "-q", "-b", "feat"); writeFileSync(join(f.upstream, "f.txt"), "f"); git(f.upstream, "add", "f.txt"); git(f.upstream, ...commit, "commit", "-q", "-m", "feat"); git(f.upstream, "push", "-q", "origin", "feat");
    const head = git(f.upstream, "rev-parse", "HEAD");
    git(f.upstream, "checkout", "-q", "main"); f.land("main2.txt");
    const pr = f.addPr({ headRefName: "feat", headRefOid: head });
    await f.sentinel.pass(f.repoBoard.id);
    const [card] = f.sentinelCards();
    const worktree = join(f.dir, "data", "worktrees", card.id);
    execFileSync("git", ["clone", "-q", f.origin, worktree]);
    git(worktree, "switch", "-q", "-C", "feat", "origin/feat"); git(worktree, ...commit, "rebase", "-q", "origin/main");
    f.land("main3.txt");
    const run = f.board.claim(card.id);
    f.board.finish(run.id, "review");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(git(worktree, "ls-remote", "origin", "refs/heads/feat").split("\t")[0], git(worktree, "rev-parse", "HEAD"));
    git(worktree, "merge-base", "--is-ancestor", "origin/main", "HEAD");
    assert.equal(f.board.getCard(card.id)?.status, "done");
    assert.match(f.comments.get(pr.number)!.map(item => item.body).join("\n"), /pushed/);
  } finally { f.cleanup(); }
});
