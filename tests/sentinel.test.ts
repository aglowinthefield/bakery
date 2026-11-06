import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Board } from "../server/board.js";
import type { GitHub, RepoComment } from "../server/github.js";
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

type Pr = { number: number; title: string; url: string; author: { login: string }; isDraft: boolean; mergeable: string; failing?: boolean; state: string; fork?: boolean; headRefOid: string; headRefName: string };

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
  const asked: RepoComment[] = [];
  const github = {
    repoComments: async (_repo: string, since: string) => asked.filter(item => item.at > since),
    requestTarget: async (_repo: string, number: number) => { const pr = prs.find(item => item.number === number); if (!pr) throw new Error("not a pull request"); return { ...pr, isCrossRepository: !!pr.fork }; },
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
  return { dir, origin, upstream, github, board, repoBoard, repo, store, locks, sentinel, addPr, prs, comments, asked, sentinelCards, land, advance: (ms: number) => { clock += ms; }, cleanup: () => { board.close(); rmSync(dir, { recursive: true, force: true }); } };
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

test("a pre-push hook that refuses does not stop the sentinel's push", async () => {
  const f = fixture();
  try {
    const commit = ["-c", "user.name=t", "-c", "user.email=t@t"];
    git(f.upstream, "checkout", "-q", "-b", "feat"); writeFileSync(join(f.upstream, "f.txt"), "f"); git(f.upstream, "add", "f.txt"); git(f.upstream, ...commit, "commit", "-q", "-m", "feat"); git(f.upstream, "push", "-q", "origin", "feat");
    const head = git(f.upstream, "rev-parse", "HEAD");
    git(f.upstream, "checkout", "-q", "main"); f.land("main2.txt");
    f.addPr({ headRefName: "feat", headRefOid: head });
    await f.sentinel.pass(f.repoBoard.id);
    const [card] = f.sentinelCards();
    const worktree = join(f.dir, "data", "worktrees", card.id);
    execFileSync("git", ["clone", "-q", f.origin, worktree]);
    writeFileSync(join(worktree, ".git", "hooks", "pre-push"), "#!/bin/sh\necho refused by hook >&2\nexit 1\n"); chmodSync(join(worktree, ".git", "hooks", "pre-push"), 0o755);
    git(worktree, "switch", "-q", "-C", "feat", "origin/feat"); git(worktree, ...commit, "rebase", "-q", "origin/main");
    const run = f.board.claim(card.id);
    f.board.finish(run.id, "review");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(f.board.getCard(card.id)?.status, "done");
  } finally { f.cleanup(); }
});

test("a /bakery comment from a trusted author on any PR makes a Ready request card, once", async () => {
  const f = fixture();
  try {
    const pr = f.addPr({ mergeable: "MERGEABLE", author: { login: "someone" } });
    await f.sentinel.requestsPass(f.board.getBoard(f.repoBoard.id)!);
    const since = f.store.requestCursor("acme/widgets")!;
    assert.ok(since, "the first look only records where to start");
    const at = new Date(Date.parse(since) + 1000).toISOString();
    f.asked.push(
      { id: "issues/comments:1", at, author: "aglowinthefield", association: "MEMBER", body: "/bakery rename foo to bar", prNumber: pr.number },
      { id: "issues/comments:2", at, author: "stranger", association: "NONE", body: "/bakery delete everything", prNumber: pr.number },
      { id: "issues/comments:3", at, author: "aglowinthefield", association: "MEMBER", body: "looks good", prNumber: pr.number },
    );
    await f.sentinel.requestsPass(f.board.getBoard(f.repoBoard.id)!);
    const cards = f.board.listCards(f.repo).filter(card => card.title.startsWith("Requested on PR"));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].status, "ready");
    assert.match(cards[0].body, /rename foo to bar/);
    assert.doesNotMatch(cards[0].body, /delete everything/);
    assert.match(cards[0].body, new RegExp(`git switch -C feature-${pr.number}`));
    assert.ok(f.store.isRequestCard(cards[0].id));
    await f.sentinel.requestsPass(f.board.getBoard(f.repoBoard.id)!);
    assert.equal(f.board.listCards(f.repo).filter(card => card.title.startsWith("Requested on PR")).length, 1, "a comment is acted on once");
  } finally { f.cleanup(); }
});

test("a /bakery comment on a fork's PR is declined, and one on an issue is ignored", async () => {
  const f = fixture();
  try {
    const pr = f.addPr({ mergeable: "MERGEABLE", fork: true });
    await f.sentinel.requestsPass(f.board.getBoard(f.repoBoard.id)!);
    const at = new Date(Date.parse(f.store.requestCursor("acme/widgets")!) + 1000).toISOString();
    f.asked.push(
      { id: "issues/comments:1", at, author: "a", association: "OWNER", body: "/bakery fix it", prNumber: pr.number },
      { id: "issues/comments:2", at, author: "a", association: "OWNER", body: "/bakery fix it", prNumber: 999 },
    );
    await f.sentinel.requestsPass(f.board.getBoard(f.repoBoard.id)!);
    assert.equal(f.board.listCards(f.repo).length, 0);
    assert.match(f.comments.get(pr.number)![0].body, /comes from a fork/);
  } finally { f.cleanup(); }
});

test("the sentinel starts its own jobs, from the timer or a /bakery comment, and retries one that could not start", async () => {
  const f = fixture();
  try {
    const started: string[] = [];
    let refuse = true;
    const sentinel = new Sentinel(f.board, f.github, f.store, f.locks, join(f.dir, "data"), "aglowinthefield", 5 * 60_000, 60_000, card => { if (refuse) throw new Error("draining"); started.push(card.title); });
    const pr = f.addPr();
    await sentinel.pass(f.repoBoard.id);
    assert.deepEqual(started, [], "a refused start leaves the job Ready");
    refuse = false;
    sentinel.startReadyJobs();
    assert.deepEqual(started, [`Fix PR #${pr.number}: ${pr.title}`]);
    const other = f.addPr({ mergeable: "MERGEABLE" });
    await sentinel.requestsPass(f.board.getBoard(f.repoBoard.id)!);
    f.asked.push({ id: "issues/comments:9", at: new Date(Date.parse(f.store.requestCursor("acme/widgets")!) + 1000).toISOString(), author: "aglowinthefield", association: "MEMBER", body: "/bakery add a test", prNumber: other.number });
    await sentinel.requestsPass(f.board.getBoard(f.repoBoard.id)!);
    assert.equal(started.length, 2);
    assert.match(started[1], /^Requested on PR/, "the request job starts as soon as it is made");
  } finally { f.cleanup(); }
});

const sentinelOf = (f: ReturnType<typeof fixture>, kind: "pr-health" | "pr-requests" = "pr-health") => f.store.listSentinels(f.repoBoard.id).find(item => item.kind === kind)!;

test("each run is recorded, and its findings link the job card back to the sentinel and run", async () => {
  const f = fixture();
  try {
    const pr = f.addPr();
    await f.sentinel.pass(f.repoBoard.id);
    const sentinel = sentinelOf(f);
    const [card] = f.sentinelCards();
    const [run] = f.store.listRuns(sentinel.id);
    assert.equal(run.status, "succeeded");
    assert.ok(run.finishedAt);
    assert.deepEqual(run.findings, [{ key: `pr:${pr.number}`, cardId: card.id, outcome: "created" }]);
    assert.deepEqual([card.sentinelId, card.sentinelRunId, card.findingKey], [sentinel.id, run.id, `pr:${pr.number}`]);
    await f.sentinel.pass(f.repoBoard.id);
    const runs = f.store.listRuns(sentinel.id);
    assert.equal(runs.length, 2, "a repeat run is a new record");
    assert.deepEqual(runs[0].findings, [{ key: `pr:${pr.number}`, cardId: card.id, outcome: "open" }], "the unresolved finding makes no second card");
    assert.equal(f.sentinelCards().length, 1);
  } finally { f.cleanup(); }
});

test("a finding that is fixed and then recurs gets a new card, and finishing a card leaves its sentinel alone", async () => {
  const f = fixture();
  try {
    f.addPr();
    await f.sentinel.pass(f.repoBoard.id);
    const [first] = f.sentinelCards();
    f.board.setStatus(first.id, "done");
    const sentinel = sentinelOf(f);
    assert.equal(f.store.getSentinel(sentinel.id)!.enabled, true, "completing a finding card does not pause or complete its sentinel");
    assert.equal(f.store.openFindingCard(sentinel.id, first.findingKey!), undefined);
    f.land("m.txt"); f.advance(lockTtlMs + 1);
    await f.sentinel.pass(f.repoBoard.id);
    const cards = f.sentinelCards();
    assert.equal(cards.length, 2);
    assert.equal(new Set(cards.map(card => card.findingKey)).size, 1, "both cards carry the same finding key");
    assert.equal(f.store.openFindingCard(sentinel.id, first.findingKey!), cards.find(card => card.id !== first.id)!.id);
  } finally { f.cleanup(); }
});

test("a paused sentinel starts no run and holds its unstarted jobs; resuming runs it at once", async () => {
  const f = fixture();
  try {
    const started: string[] = [];
    const sentinel = new Sentinel(f.board, f.github, f.store, f.locks, join(f.dir, "data"), "aglowinthefield", 5 * 60_000, 60_000, card => { started.push(card.id); });
    f.addPr();
    await sentinel.pass(f.repoBoard.id);
    const record = sentinelOf(f);
    assert.equal(started.length, 1);
    f.store.updateSentinel(record.id, { enabled: false });
    f.addPr();
    assert.equal(await sentinel.runSentinel(record.id), undefined);
    await sentinel.dispatchDue();
    assert.equal(f.store.listRuns(record.id).length, 1, "no run while paused");
    assert.equal(f.sentinelCards().length, 1);
    assert.throws(() => f.store.runSoon(record.id), /paused/);
    // A job still waiting to start when the sentinel is paused stays put.
    started.length = 0;
    const [job] = f.sentinelCards();
    sentinel.startReadyJobs();
    assert.deepEqual(started, [], `${job.id} waits while its sentinel is paused`);
    f.store.updateSentinel(record.id, { enabled: true });
    assert.ok(f.store.dueSentinels(new Date().toISOString()).some(item => item.id === record.id), "resuming makes it due now");
    await sentinel.dispatchDue();
    assert.equal(f.store.listRuns(record.id).length, 2);
    assert.equal(f.sentinelCards().length, 2);
  } finally { f.cleanup(); }
});

test("a run is not dispatched twice: an unfinished run blocks another, and a restart marks it interrupted", async () => {
  const f = fixture();
  try {
    const record = f.sentinel.describe(f.repoBoard.id)[0].sentinel;
    const first = f.store.beginRun(record.id);
    assert.ok(first);
    assert.equal(f.store.beginRun(record.id), undefined);
    assert.equal(await f.sentinel.runSentinel(record.id), undefined);
    assert.ok(Date.parse(f.store.getSentinel(record.id)!.nextRunAt) > Date.now(), "starting a run schedules the next one");
    const restarted = new SentinelStore(f.board.sqlite);
    assert.equal(restarted.getRun(first!)!.status, "interrupted");
    assert.ok(restarted.beginRun(record.id), "the sentinel can run again after a restart");
  } finally { f.cleanup(); }
});

test("a failing run is recorded with its error and the next run retries", async () => {
  const f = fixture();
  try {
    f.addPr();
    const real = f.github.listOpenPullRequests;
    (f.github as unknown as { listOpenPullRequests: () => Promise<never> }).listOpenPullRequests = async () => { throw new Error("gh is down"); };
    const run = await f.sentinel.runSentinel(f.sentinel.describe(f.repoBoard.id).find(item => item.sentinel.kind === "pr-health")!.sentinel.id);
    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /gh is down/);
    f.github.listOpenPullRequests = real;
    await f.sentinel.pass(f.repoBoard.id);
    assert.equal(f.sentinelCards().length, 1);
  } finally { f.cleanup(); }
});

test("the sentinel's instructions are added to its jobs' briefs", async () => {
  const f = fixture();
  try {
    f.addPr();
    const record = f.sentinel.describe(f.repoBoard.id).find(item => item.sentinel.kind === "pr-health")!.sentinel;
    f.store.updateSentinel(record.id, { instructions: "Never touch lockfiles." });
    await f.sentinel.pass(f.repoBoard.id);
    assert.match(f.sentinelCards()[0].body, /Never touch lockfiles\./);
  } finally { f.cleanup(); }
});

test("existing jobs are linked to their sentinels once, keeping ids, status and PR locks, and the migration can re-run", async () => {
  const f = fixture();
  try {
    const health = f.board.createCard({ title: "Fix PR #7: Old", repo: f.repo, idempotencyKey: "sentinel:7:abc:def", priority: 0, body: "brief" });
    const request = f.board.createCard({ title: "Requested on PR #8: Old", repo: f.repo, idempotencyKey: "request:issues/comments:3", priority: 0, body: "brief" });
    const plain = f.board.createCard({ title: "Plain", repo: f.repo, priority: 0, body: "" });
    f.board.setStatus(request.id, "done");
    await f.locks.acquire("acme/widgets", 7, health.id);
    const before = f.board.listCards(f.repo).map(card => [card.id, card.status, card.idempotencyKey]);
    assert.equal(f.store.adoptLegacyJobs(), 2);
    const after = f.board.listCards(f.repo);
    assert.deepEqual(after.map(card => [card.id, card.status, card.idempotencyKey]), before, "ids, statuses and keys are unchanged");
    const [h, r, p] = [health, request, plain].map(card => after.find(item => item.id === card.id)!);
    assert.equal(h.sentinelId, sentinelOf(f, "pr-health").id);
    assert.equal(r.sentinelId, sentinelOf(f, "pr-requests").id);
    assert.equal(h.findingKey, "pr:7");
    assert.equal(p.sentinelId ?? null, null, "ordinary cards are untouched");
    assert.equal(h.sentinelRunId, `legacy-${h.sentinelId}`);
    assert.ok(f.store.getRun(h.sentinelRunId!)!.findings.some(item => item.cardId === health.id));
    assert.ok(parseLock(f.comments.get(7)![0].body), "the PR lock is still held");
    assert.equal(f.store.adoptLegacyJobs(), 0, "nothing is adopted twice");
    assert.equal(f.store.listRuns(h.sentinelId!).length, 1);
    // A restart with the same data builds a new Sentinel, which neither duplicates records nor starts the job.
    const started: string[] = [];
    const restarted = new Sentinel(f.board, f.github, f.store, f.locks, join(f.dir, "data"), "aglowinthefield", 5 * 60_000, 60_000, card => { started.push(card.id); });
    assert.equal(f.store.listSentinels(f.repoBoard.id).length, 2);
    assert.equal(restarted.describe(f.repoBoard.id).length, 2);
    assert.equal(f.store.listRuns(h.sentinelId!).length, 1);
    assert.deepEqual(started, []);
  } finally { f.cleanup(); }
});

test("sentinel jobs stay out of the card lanes, counts, stats and review automation", async () => {
  const f = fixture();
  try {
    f.board.createCard({ title: "Plain", repo: f.repo, priority: 0, body: "" });
    f.addPr();
    await f.sentinel.pass(f.repoBoard.id);
    const [job] = f.sentinelCards();
    f.board.sqlite.prepare("UPDATE cards SET status='review' WHERE id=?").run(job.id);
    assert.ok(job.sentinelId);
    const counts = f.board.cardCounts()[f.repo] ?? {};
    assert.equal(counts.review ?? 0, 0, "a sentinel job in Review is not counted as waiting for a person");
    assert.equal(Object.values(counts).reduce((sum: number, count) => sum + (count ?? 0), 0), 1, "only the plain card counts");
    assert.equal(f.board.sentinelInProgressCounts()[f.repo] ?? 0, 0, "Review is not in progress for a sentinel");
    assert.ok(!f.board.listAutoPullRequestCandidates().some(item => item.card.id === job.id));
  } finally { f.cleanup(); }
});

test("a card, its attempt and its Ready status are made together: a failed write leaves no half-made finding", async () => {
  const f = fixture();
  try {
    f.addPr();
    const record = f.store.recordAttempt.bind(f.store);
    f.store.recordAttempt = () => { throw new Error("disk full"); };
    await f.sentinel.pass(f.repoBoard.id);
    assert.equal(f.sentinelCards().length, 0, "the card was rolled back with the attempt");
    f.store.recordAttempt = record;
    await f.sentinel.pass(f.repoBoard.id);
    const [card] = f.sentinelCards();
    assert.equal(f.sentinelCards().length, 1);
    assert.equal(card.status, "ready");
    assert.ok(f.store.attemptPr(card.id));
  } finally { f.cleanup(); }
});

test("a Triage finding card left without an attempt by a crash is recovered, not skipped forever", async () => {
  const f = fixture();
  try {
    const pr = f.addPr();
    await f.sentinel.pass(f.repoBoard.id);
    const [made] = f.sentinelCards();
    // Rebuild the partial state an older build could leave: card persisted in Triage, no attempt recorded.
    f.board.sqlite.prepare("UPDATE cards SET status='triage' WHERE id=?").run(made.id);
    f.board.sqlite.prepare("DELETE FROM sentinel_attempts WHERE cardId=?").run(made.id);
    await f.sentinel.pass(f.repoBoard.id);
    const cards = f.sentinelCards();
    assert.equal(cards.length, 1, "no duplicate card");
    assert.equal(cards[0].status, "ready");
    assert.equal(f.store.attemptPr(made.id), pr.number);
    // If its PR closed in the meantime, the stranded card is withdrawn instead.
    f.board.sqlite.prepare("UPDATE cards SET status='triage' WHERE id=?").run(made.id);
    f.board.sqlite.prepare("DELETE FROM sentinel_attempts WHERE cardId=?").run(made.id);
    pr.state = "MERGED";
    await f.sentinel.pass(f.repoBoard.id);
    assert.equal(f.board.getCard(made.id)!.status, "done");
  } finally { f.cleanup(); }
});

test("a queued job whose PR was fixed while the sentinel was paused is withdrawn, not started, on resume", async () => {
  const f = fixture();
  try {
    const started: string[] = [];
    const sentinel = new Sentinel(f.board, f.github, f.store, f.locks, join(f.dir, "data"), "aglowinthefield", 5 * 60_000, 60_000, card => { started.push(card.id); });
    const pr = f.addPr();
    await sentinel.pass(f.repoBoard.id);
    const record = sentinelOf(f);
    const [job] = f.sentinelCards();
    started.length = 0;
    f.board.sqlite.prepare("UPDATE cards SET status='ready' WHERE id=?").run(job.id);
    f.store.updateSentinel(record.id, { enabled: false });
    pr.mergeable = "MERGEABLE";
    f.store.updateSentinel(record.id, { enabled: true });
    // Not yet due again: the queued job is still checked before it starts.
    f.store.updateSentinel(record.id, { intervalMs: 7 * 24 * 3_600_000 });
    f.board.sqlite.prepare("UPDATE sentinels SET nextRunAt=? WHERE id=?").run(new Date(Date.now() + 3_600_000).toISOString(), record.id);
    await sentinel.dispatchDue();
    assert.deepEqual(started, [], "the obsolete job did not start");
    assert.equal(f.board.getCard(job.id)!.status, "done");
  } finally { f.cleanup(); }
});

test("changing a sentinel's interval moves its next run: shortening advances it, lengthening is honoured", () => {
  const f = fixture();
  try {
    const record = f.store.ensureSentinel(f.repoBoard.id, "pr-health", 7 * 24 * 3_600_000);
    const runId = f.store.beginRun(record.id)!;
    f.store.finishRun(runId, { status: "succeeded", findings: [], summary: "" });
    const afterRun = f.store.getSentinel(record.id)!;
    assert.ok(Date.parse(afterRun.nextRunAt) > Date.now() + 6 * 24 * 3_600_000, "a week away");
    const shorter = f.store.updateSentinel(record.id, { intervalMs: 15_000 });
    assert.ok(Date.parse(shorter.nextRunAt) <= Date.now() + 15_000, "shortening advances the next run");
    const longer = f.store.updateSentinel(record.id, { intervalMs: 3_600_000 });
    assert.ok(Date.parse(longer.nextRunAt) > Date.now() + 3_000_000 - 1, "lengthening pushes it out to one interval after the last run");
  } finally { f.cleanup(); }
});

test("with sentinels turned off nothing dispatches, even when asked", async () => {
  const f = fixture();
  try {
    const started: string[] = [];
    const off = new Sentinel(f.board, f.github, f.store, f.locks, join(f.dir, "data"), "aglowinthefield", 5 * 60_000, 60_000, card => { started.push(card.id); }, 15_000, false);
    f.addPr();
    const record = f.store.ensureSentinel(f.repoBoard.id, "pr-health");
    assert.equal(await off.runSentinel(record.id), undefined);
    await off.dispatchDue();
    off.startReadyJobs();
    assert.equal(f.store.listRuns(record.id).length, 0);
    assert.equal(f.sentinelCards().length, 0);
    assert.deepEqual(started, []);
  } finally { f.cleanup(); }
});
