import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Board } from "../server/board.js";
import { Worker } from "../server/worker.js";
import { Integration } from "../server/integration.js";
import { GitHub, GitHubSync, checksState, fastForwardMain, fixableFailures, hasWorktrunk, linkedPullRequest, maxCiReworks, trimFailedLog, type PullRequest } from "../server/github.js";
import { githubRepo, parsePullRequestUrl } from "../server/github-url.js";
import { draftPullRequest, readPullRequestRules } from "../server/pr-draft.js";
import { semanticTitleProblem } from "../src/pr-title.js";

// A local bare repository plays origin and a fake `gh` on PATH plays GitHub. The fake keeps its pull requests
// in prs.json, logs each call to calls.log, and fails `auth status` while auth-fail exists.
const fakeGh = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = process.env.FAKE_GH_DIR, args = process.argv.slice(2), file = path.join(dir, "prs.json");
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(args) + "\\n");
const prs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
// Like gh, return only the fields asked for with --json.
const pick = pr => flag("--json") ? Object.fromEntries(flag("--json").split(",").filter(key => key in pr).map(key => [key, pr[key]])) : pr;
if (args[0] === "--version") { console.log("gh version 2.99.0 (fake)"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") {
  if (fs.existsSync(path.join(dir, "auth-fail"))) { console.error("You are not logged into any GitHub hosts. To log in, run: gh auth login"); process.exit(1); }
  console.log("Logged in to github.com"); process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  const head = flag("--head");
  console.log(JSON.stringify(prs.filter(pr => !head || pr.headRefName === head).reverse().map(pick)));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const pr = prs.find(item => item.number === Number(args[2]));
  if (!pr) { console.error("GraphQL: Could not resolve to a PullRequest with the number of " + args[2] + "."); process.exit(1); }
  console.log(JSON.stringify(pick(pr))); process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  if (fs.existsSync(path.join(dir, "create-error"))) { process.stderr.write(fs.readFileSync(path.join(dir, "create-error"), "utf8")); process.exit(1); }
  const number = 100 + prs.length, url = "https://github.com/" + flag("--repo") + "/pull/" + number;
  prs.push({ number, url, state: "OPEN", mergedAt: null, mergeCommit: null, headRefName: flag("--head"), headRefOid: "", statusCheckRollup: [],
    title: flag("--title"), body: flag("--body"), base: flag("--base") });
  fs.writeFileSync(file, JSON.stringify(prs));
  console.log(url); process.exit(0);
}
if (args[0] === "run" && args[1] === "view") {
  const log = path.join(dir, "job-" + flag("--job") + ".log");
  if (!fs.existsSync(log)) { console.error("job not found"); process.exit(1); }
  process.stdout.write(fs.readFileSync(log, "utf8")); process.exit(0);
}
console.error("fake gh: unsupported " + args.join(" ")); process.exit(2);
`;

const commitArgs = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm"];
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture(wtBin?: string) {
  const dir = mkdtempSync(join(tmpdir(), "bakery-github-"));
  const bin = join(dir, "bin"), ghDir = join(dir, "gh"), origin = join(dir, "origin.git"), repo = join(dir, "repo"), upstream = join(dir, "upstream"), data = join(dir, "data");
  mkdirSync(bin); mkdirSync(ghDir);
  writeFileSync(join(bin, "gh"), fakeGh); chmodSync(join(bin, "gh"), 0o755);
  const fakePi = join(dir, "pi-fake");
  writeFileSync(fakePi, `#!/bin/sh\necho "feature from $(basename "$PWD")" > feature.txt\nprintf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Added feature.txt"}}' '{"type":"agent_settled","aborted":false}'\n`);
  chmodSync(fakePi, 0o755);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, upstream], { stdio: "ignore" });
  git(upstream, "checkout", "-q", "-b", "main");
  writeFileSync(join(upstream, "README.md"), "fixture\n");
  git(upstream, "add", "README.md"); git(upstream, ...commitArgs, "initial"); git(upstream, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.FAKE_GH_DIR = ghDir;
  const board = new Board(join(dir, "board.sqlite"));
  const repoBoard = board.addRepo(repo);
  board.setRemoteUrl(repoBoard.id, "https://github.com/acme/widgets");
  board.setIntegration(repoBoard.id, "github-pr");
  const github = new GitHub("gh");
  const sync = new GitHubSync(board, data, github, wtBin);
  const prs = () => (existsSync(join(ghDir, "prs.json")) ? JSON.parse(readFileSync(join(ghDir, "prs.json"), "utf8")) : []) as (PullRequest & { title: string; body: string; base: string })[];
  const setPrs = (value: unknown[]) => writeFileSync(join(ghDir, "prs.json"), JSON.stringify(value));
  const calls = () => existsSync(join(ghDir, "calls.log")) ? readFileSync(join(ghDir, "calls.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
  /** Lands a commit on origin/main from another clone, as other merged work would. */
  const landUpstream = (name: string) => {
    git(upstream, "pull", "-q", "--ff-only", "origin", "main");
    writeFileSync(join(upstream, name), `${name}\n`); git(upstream, "add", name); git(upstream, ...commitArgs, `land ${name}`); git(upstream, "push", "-q", "origin", "main");
    return git(upstream, "rev-parse", "HEAD");
  };
  /** Squash-merges a pushed branch on "GitHub": one new commit on origin/main, not a descendant of the branch. */
  const squashMerge = (branch: string) => {
    git(upstream, "pull", "-q", "--ff-only", "origin", "main");
    git(upstream, "fetch", "-q", "origin", branch);
    git(upstream, "merge", "-q", "--squash", "FETCH_HEAD"); git(upstream, ...commitArgs, `squash ${branch}`); git(upstream, "push", "-q", "origin", "main");
    return git(upstream, "rev-parse", "HEAD");
  };
  const cleanup = () => { board.close(); process.env.PATH = previousPath; delete process.env.FAKE_GH_DIR; rmSync(dir, { recursive: true, force: true }); };
  return { dir, ghDir, origin, repo, upstream, data, fakePi, board, repoBoard, github, sync, prs, setPrs, calls, landUpstream, squashMerge, cleanup };
}
type Fixture = ReturnType<typeof fixture>;

async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Runs the fake Pi on a new card so it reaches Review with an uncommitted feature.txt. */
async function reviewedCard(f: Fixture, title = "Add feature") {
  const card = f.board.createCard({ title, body: "Card body text.", repo: f.repo });
  f.board.setStatus(card.id, "ready");
  const run = new Worker(f.board, f.data, f.fakePi).start(f.board.getCard(card.id)!);
  await waitFor(() => f.board.getRun(run.id)?.status !== "running");
  assert.equal(f.board.getRun(run.id)?.status, "review", f.board.getRun(run.id)?.error ?? "");
  return f.board.getCard(card.id)!;
}

async function approve(f: Fixture, cardId: string) {
  const card = f.board.getCard(cardId)!;
  const integration = new Integration(f.board, f.data);
  return integration.openPullRequest(card, integration.review(card).fingerprint, f.github);
}

const externalRow = (f: Fixture, cardId: string) => {
  const db = new DatabaseSync(join(f.dir, "board.sqlite"));
  try { return db.prepare("SELECT runId, candidate, mergeCommit, integratedAt FROM external_integrations WHERE cardId=?").get(cardId) as { mergeCommit: string; candidate: string } | undefined; }
  finally { db.close(); }
};

test("GitHub remotes and pull request links parse without the network", () => {
  assert.equal(githubRepo("https://github.com/acme/widgets"), "acme/widgets");
  assert.equal(githubRepo("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(githubRepo("https://gitlab.com/acme/widgets"), undefined);
  assert.deepEqual(parsePullRequestUrl("https://github.com/acme/widgets/pull/42"), { repo: "acme/widgets", number: 42 });
  assert.equal(parsePullRequestUrl("https://github.com/acme/widgets/issues/42"), undefined);
  assert.equal(checksState({ statusCheckRollup: [{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }] } as PullRequest), "pending");
  assert.equal(checksState({ statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }] } as PullRequest), "failing");
  assert.equal(checksState({ statusCheckRollup: [{ state: "SUCCESS" }] } as PullRequest), "passing");
});

test("github-pr needs a GitHub remote, and the remote stays GitHub while the mode is on", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-github-"));
  try {
    execFileSync("git", ["init", "-q", join(dir, "repo")]);
    const board = new Board(join(dir, "board.sqlite"));
    const repoBoard = board.addRepo(join(dir, "repo"));
    assert.equal(repoBoard.integration, "local");
    assert.throws(() => board.setIntegration(repoBoard.id, "github-pr"), /GitHub repository link/);
    board.setRemoteUrl(repoBoard.id, "https://gitlab.com/acme/widgets");
    assert.throws(() => board.setIntegration(repoBoard.id, "github-pr"), /GitHub repository link/);
    board.setRemoteUrl(repoBoard.id, "https://github.com/acme/widgets");
    assert.equal(board.setIntegration(repoBoard.id, "github-pr").integration, "github-pr");
    assert.throws(() => board.setRemoteUrl(repoBoard.id, "https://gitlab.com/acme/widgets"), /must stay/);
    assert.throws(() => board.setIntegration(repoBoard.id, "svn"), /local or github-pr/);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a card's PR is found by its bakery/<id> branch, and an attached PR link overrides the lookup", async () => {
  const f = fixture();
  try {
    const card = f.board.createCard({ title: "Lookup", body: "", repo: f.repo });
    f.setPrs([
      { number: 7, url: "https://github.com/acme/widgets/pull/7", state: "CLOSED", mergedAt: null, mergeCommit: null, headRefName: `bakery/${card.id}` },
      { number: 8, url: "https://github.com/acme/widgets/pull/8", state: "OPEN", mergedAt: null, mergeCommit: null, headRefName: `bakery/${card.id}` },
      { number: 9, url: "https://github.com/acme/widgets/pull/9", state: "OPEN", mergedAt: null, mergeCommit: null, headRefName: "feature/custom-name" },
    ]);
    assert.equal((await linkedPullRequest(f.github, "acme/widgets", card))?.number, 8, "the newest PR from the branch");
    assert.deepEqual(f.calls().at(-1)?.slice(0, 6), ["pr", "list", "--repo", "acme/widgets", "--head", `bakery/${card.id}`]);
    assert.throws(() => f.board.setPullRequestOverride(card.id, "https://example.com/pull/9"), /must look like/);
    assert.throws(() => f.board.setPullRequestOverride(card.id, "https://github.com/other/repo/pull/9"), /this board's remote is acme\/widgets/);
    const linked = f.board.setPullRequestOverride(card.id, "https://github.com/acme/widgets/pull/9");
    assert.equal(linked.prNumber, 9);
    assert.equal(linked.prUrl, "https://github.com/acme/widgets/pull/9");
    assert.equal((await linkedPullRequest(f.github, "acme/widgets", linked))?.headRefName, "feature/custom-name");
    assert.deepEqual(f.calls().at(-1)?.slice(0, 3), ["pr", "view", "9"]);
    const cleared = f.board.setPullRequestOverride(card.id, "");
    assert.equal(cleared.prOverrideUrl, null);
    assert.equal((await linkedPullRequest(f.github, "acme/widgets", cleared))?.number, 8);
  } finally { f.cleanup(); }
});

test("github-pr: a card starts from origin/main, Approve pushes and opens a PR, and the card is Done only once the merge is on origin/main", async () => {
  const f = fixture();
  try {
    // Origin moved since the clone; local main is stale until the next sync.
    const staleMain = git(f.repo, "rev-parse", "main");
    const upstreamTip = f.landUpstream("other.txt");
    assert.notEqual(staleMain, upstreamTip);
    const card = await reviewedCard(f);
    const worktree = join(f.data, "worktrees", card.id);
    assert.equal(git(worktree, "rev-parse", "HEAD"), upstreamTip, "the worktree starts at the fetched origin/main, not stale HEAD");

    // Local-merge approval is refused on this board; Approve opens a PR instead.
    const integration = new Integration(f.board, f.data);
    assert.throws(() => integration.approve(card, integration.review(card).fingerprint), /GitHub pull requests/);
    const approved = await approve(f, card.id);
    assert.equal(approved.status, "review");
    assert.equal(approved.prNumber, 100);
    assert.equal(approved.prUrl, "https://github.com/acme/widgets/pull/100");
    const [pr] = f.prs();
    assert.equal(pr.title, "Add feature");
    assert.equal(pr.base, "main");
    assert.match(pr.body, /^Card body text\./);
    assert.match(pr.body, /Run summary[\s\S]*Added feature\.txt/);
    const pushed = git(f.origin, "rev-parse", `refs/heads/bakery/${card.id}`);
    assert.equal(pushed, git(worktree, "rev-parse", "HEAD"), "the reviewed work was committed and pushed");
    assert.equal(git(f.repo, "rev-parse", "main"), staleMain, "nothing merged into local main");
    assert.equal(git(f.repo, "rev-list", "--count", `origin/main..${pushed}`), "1", "one card commit on top of the fetched origin/main");

    // Open: stays in Review with the PR number and checks state; local main catches up with origin.
    f.setPrs([{ ...pr, headRefOid: pushed, statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] }]);
    await f.sync.syncBoard(f.repoBoard.id);
    assert.equal(f.board.getBoard(f.repoBoard.id)?.integrationError, "");
    let current = f.board.getCard(card.id)!;
    assert.equal(current.status, "review");
    assert.equal(current.prState, "OPEN");
    assert.equal(current.prChecks, "pending");
    assert.equal(git(f.repo, "rev-parse", "main"), upstreamTip, "local main fast-forwarded to origin/main");
    const listCalls = f.calls().filter(call => call[0] === "pr" && call[1] === "list" && !call.includes("--head"));
    assert.equal(listCalls.length, 1, "one batched gh pr list per board per tick");

    // Merged on GitHub, but the merge commit is not on origin/main yet: stay in Review.
    const elsewhere = join(f.dir, "elsewhere");
    execFileSync("git", ["clone", "-q", f.origin, elsewhere], { stdio: "ignore" });
    writeFileSync(join(elsewhere, "x.txt"), "x\n"); git(elsewhere, "add", "x.txt"); git(elsewhere, ...commitArgs, "unpublished");
    f.setPrs([{ ...pr, state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: git(elsewhere, "rev-parse", "HEAD") }, headRefOid: pushed }]);
    await f.sync.syncBoard(f.repoBoard.id);
    current = f.board.getCard(card.id)!;
    assert.equal(current.status, "review");
    assert.match(current.prError ?? "", /waiting for .* to reach origin\/main/);
    assert.equal(externalRow(f, card.id), undefined);

    // Squash-merged and on origin/main: Done, recorded, main fast-forwarded, worktree and branch removed.
    const merge = f.squashMerge(`bakery/${card.id}`);
    f.setPrs([{ ...pr, state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: merge }, headRefOid: pushed }]);
    await f.sync.syncBoard(f.repoBoard.id);
    current = f.board.getCard(card.id)!;
    assert.equal(current.status, "done");
    assert.equal(current.prState, "MERGED");
    assert.deepEqual({ ...externalRow(f, card.id) }, { ...externalRow(f, card.id), candidate: pushed, mergeCommit: merge });
    assert.equal(git(f.repo, "rev-parse", "main"), merge);
    assert.equal(readFileSync(join(f.repo, "feature.txt"), "utf8"), `feature from ${card.id}\n`);
    assert.equal(existsSync(worktree), false, "the Done card's worktree was removed");
    assert.equal(git(f.repo, "branch", "--list", `bakery/${card.id}`), "", "the squash-merged branch was force-deleted after GitHub confirmed the merge");
  } finally { f.cleanup(); }
});

// Shaped like silkcx/silk-remix: amannn/action-semantic-pull-request with types and scopes, and a template with
// Staging QA and Screenshots sections that a separate workflow checks.
const semanticWorkflow = `name: Semantic PR Title
on:
  pull_request:
    types: [opened, edited]
jobs:
  semantic-pr:
    runs-on: ubuntu-latest
    steps:
      - uses: amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50 # v6
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        with:
          types: |
            feat
            fix
            chore
          # Dependabot's own scopes must be allowed too.
          scopes: |
            web
            api
            deps
      - name: Unrelated
        with:
          scopes: |
            nope
`;
const prTemplate = "Summary\n\n- What changed and why?\n\n## Staging QA\n\n- Action: <action on staging>\n\n## Screenshots / Demos\n\n- Before: <URL>\n- After: <URL>\n";

/** Lands the repository's PR rules on origin/main before the card starts, so its worktree has them. */
function landPullRequestRules(f: Fixture) {
  git(f.upstream, "pull", "-q", "--ff-only", "origin", "main");
  mkdirSync(join(f.upstream, ".github", "workflows"), { recursive: true });
  writeFileSync(join(f.upstream, ".github", "workflows", "semantic-pr.yml"), semanticWorkflow);
  writeFileSync(join(f.upstream, ".github", "PULL_REQUEST_TEMPLATE.md"), prTemplate);
  git(f.upstream, "add", ".github"); git(f.upstream, ...commitArgs, "pr rules"); git(f.upstream, "push", "-q", "origin", "main");
}

/** A tool-free Pi stand-in that records its arguments and replies with one JSON draft. */
function fakeDrafter(f: Fixture, reply: string) {
  const path = join(f.dir, "pi-drafter"), event = (value: unknown) => JSON.stringify(value).replace(/'/g, "'\\''");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(f.dir, "drafter-args")}"\nprintf '%s\\n' '${event({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] } })}' '${event({ type: "agent_settled", aborted: false })}'\n`);
  chmodSync(path, 0o755);
  return { path, args: () => readFileSync(join(f.dir, "drafter-args"), "utf8") };
}

async function draftFor(f: Fixture, cardId: string, piBin: string) {
  const card = f.board.getCard(cardId)!, run = f.board.listRuns(cardId)[0];
  const patch = new Integration(f.board, f.data).review(card).files.map(file => file.patch).join("\n");
  return draftPullRequest({ card, run, worktree: run.worktree!, patch, piBin, models: [] });
}

test("semantic PR rules: read from the workflow step's own types and scopes, and titles are checked against them", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-rules-"));
  try {
    assert.deepEqual(readPullRequestRules(dir), { template: null, semantic: null });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "semantic-pr.yml"), semanticWorkflow);
    writeFileSync(join(dir, ".github", "pull_request_template.md"), prTemplate);
    const rules = readPullRequestRules(dir);
    assert.deepEqual(rules.semantic, { types: ["feat", "fix", "chore"], scopes: ["web", "api", "deps"], requireScope: false, source: ".github/workflows/semantic-pr.yml" });
    assert.deepEqual(rules.template, { path: ".github/pull_request_template.md", text: prTemplate });
    const semantic = rules.semantic!;
    assert.equal(semanticTitleProblem("feat(web): add the inbox filter", semantic), "");
    assert.equal(semanticTitleProblem("fix: handle empty lists", semantic), "");
    assert.equal(semanticTitleProblem("feat(web,api)!: drop v1", semantic), "");
    assert.match(semanticTitleProblem("Add feature", semantic), /must look like "type\(scope\): subject/);
    assert.match(semanticTitleProblem("docs(web): readme", semantic), /Unknown type "docs"; use one of feat, fix, chore/);
    assert.match(semanticTitleProblem("feat(mobile): app", semantic), /Unknown scope "mobile"; use one of web, api, deps/);
    assert.match(semanticTitleProblem("feat: x", { ...semantic, requireScope: true }), /scope is required/);
    // Without a types list the action's defaults apply.
    writeFileSync(join(dir, ".github", "workflows", "semantic-pr.yml"), "steps:\n  - uses: amannn/action-semantic-pull-request@v6\n");
    assert.ok(readPullRequestRules(dir).semantic!.types.includes("refactor"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("github-pr: with a PR template and a semantic-PR check, Approve drafts from them, refuses a bad title before pushing, and opens the edited PR", async () => {
  const f = fixture();
  try {
    landPullRequestRules(f);
    const card = await reviewedCard(f, "Add feature");
    const drafter = fakeDrafter(f, JSON.stringify({ title: "feat(web): add feature file", body: "Summary\n\n- Adds feature.txt.\n\n## Staging QA\n\nNo manual step: test fixture\n\n## Screenshots / Demos\n\nNo screenshots: nonvisual fixture file" }));
    const draft = await draftFor(f, card.id, drafter.path);
    assert.equal(draft.source, "agent");
    assert.equal(draft.title, "feat(web): add feature file");
    assert.match(draft.body, /## Staging QA[\s\S]*## Screenshots/);
    assert.equal(draft.problem, "");
    assert.equal(draft.templatePath, ".github/PULL_REQUEST_TEMPLATE.md");
    assert.deepEqual(draft.semantic?.scopes, ["web", "api", "deps"]);
    const args = drafter.args();
    assert.match(args, /--no-tools/, "the drafter cannot act");
    assert.match(args, /type one of feat, fix, chore and scope, if any, one of web, api, deps/);
    assert.match(args, /<template>\nSummary[\s\S]*## Staging QA/);
    assert.match(args, /<card-title>\nAdd feature\n<\/card-title>/);
    assert.match(args, /\+feature from/, "the diff is in the prompt");

    // A title that fails the check, from the card or the dialog, is refused before anything is committed or pushed.
    const integration = new Integration(f.board, f.data);
    const fingerprint = integration.review(f.board.getCard(card.id)!).fingerprint;
    await assert.rejects(integration.openPullRequest(f.board.getCard(card.id)!, fingerprint, f.github), /title "Add feature" would fail \.github\/workflows\/semantic-pr\.yml: Title must look like/);
    await assert.rejects(integration.openPullRequest(f.board.getCard(card.id)!, fingerprint, f.github, { title: "feat(mobile): x", body: "b" }), /Unknown scope "mobile"/);
    assert.throws(() => git(f.origin, "rev-parse", "--verify", "-q", `refs/heads/bakery/${card.id}`));
    assert.equal(git(join(f.data, "worktrees", card.id), "status", "--porcelain"), "?? feature.txt", "the reviewed work is still uncommitted");

    // The operator's edited draft becomes the PR, with Bakery's footer appended.
    const approved = await integration.openPullRequest(f.board.getCard(card.id)!, fingerprint, f.github, { title: "fix(api): add feature file", body: `${draft.body}\n\nEdited.` });
    assert.equal(approved.prNumber, 100);
    const [pr] = f.prs();
    assert.equal(pr.title, "fix(api): add feature file");
    assert.match(pr.body, /^Summary\n\n- Adds feature\.txt\.[\s\S]*No screenshots: nonvisual fixture file\n\nEdited\.\n\n---\n\nOpened by Bakery for card `[\w-]+`\.\n\n<details><summary>Run summary/);

    // An agent failure still gives the operator the template and the reason, and flags the card title.
    const broken = await draftFor(f, card.id, join(f.dir, "no-such-pi"));
    assert.equal(broken.source, "card");
    assert.equal(broken.body, prTemplate.trim());
    assert.match(broken.problem, /ENOENT[\s\S]*Title must look like/);
    const fenced = await draftFor(f, card.id, fakeDrafter(f, "not json").path);
    assert.match(fenced.problem, /reply was not JSON/);
  } finally { f.cleanup(); }
});

test("github-pr: with neither a PR template nor a semantic-PR check, the draft is the card text and no agent runs", async () => {
  const f = fixture();
  try {
    const card = await reviewedCard(f, "Add feature");
    const draft = await draftFor(f, card.id, join(f.dir, "no-such-pi"));
    assert.deepEqual({ ...draft }, { title: "Add feature", body: "Card body text.", source: "card", problem: "", templatePath: null, semantic: null });
    const integration = new Integration(f.board, f.data);
    await integration.openPullRequest(f.board.getCard(card.id)!, integration.review(f.board.getCard(card.id)!).fingerprint, f.github, { title: "Any title at all", body: draft.body });
    const [pr] = f.prs();
    assert.equal(pr.title, "Any title at all");
    assert.match(pr.body, /^Card body text\.\n\n---\n\nOpened by Bakery for card /);
  } finally { f.cleanup(); }
});

test("github-pr: a PR closed without merging sends the card to Needs you with the reason", async () => {
  const f = fixture();
  try {
    const card = await reviewedCard(f);
    await approve(f, card.id);
    const [pr] = f.prs();
    f.setPrs([{ ...pr, state: "CLOSED" }]);
    await f.sync.syncBoard(f.repoBoard.id);
    const current = f.board.getCard(card.id)!;
    assert.equal(current.status, "failed");
    assert.equal(current.prState, "CLOSED");
    assert.match(current.prError ?? "", /#100 was closed without merging/);
    assert.equal(externalRow(f, card.id), undefined);
  } finally { f.cleanup(); }
});

test("github-pr: gh errors from creating the PR reach the card verbatim, and the agent never pushed", async () => {
  const f = fixture();
  try {
    const card = await reviewedCard(f, "bad title");
    writeFileSync(join(f.ghDir, "create-error"), "pull request create failed: GraphQL: Title must match ^(feat|fix): (createPullRequest)\n");
    await assert.rejects(approve(f, card.id), { message: "pull request create failed: GraphQL: Title must match ^(feat|fix): (createPullRequest)" });
    assert.equal(f.board.getCard(card.id)?.status, "review");
    // The prompt still forbids the agent from pushing; only the operator's Approve pushes.
    assert.match(f.board.listRuns(card.id)[0].output + readFileSync(new URL("../server/worker.ts", import.meta.url), "utf8"), /Do not stage, commit, push, create a PR/);
  } finally { f.cleanup(); }
});

test("github-pr: without gh, or when gh is signed out, the board shows an error and does nothing", async () => {
  const f = fixture();
  try {
    const card = await reviewedCard(f);
    await approve(f, card.id);
    const [pr] = f.prs();
    f.setPrs([{ ...pr, state: "CLOSED" }]);
    const before = git(f.repo, "rev-parse", "main");
    f.landUpstream("later.txt");

    writeFileSync(join(f.ghDir, "auth-fail"), "");
    await f.sync.syncBoard(f.repoBoard.id);
    assert.match(f.board.getBoard(f.repoBoard.id)!.integrationError, /gh auth status failed.*not logged into/s);
    rmSync(join(f.ghDir, "auth-fail"));

    const missing = new GitHubSync(f.board, f.data, new GitHub(join(f.dir, "no-such-dir", "gh")));
    await missing.syncBoard(f.repoBoard.id);
    assert.match(f.board.getBoard(f.repoBoard.id)!.integrationError, /GitHub CLI unavailable: .*not installed/);
    assert.equal(f.board.getCard(card.id)?.status, "review", "no local fallback: the closed PR was not acted on");
    assert.equal(git(f.repo, "rev-parse", "main"), before, "main was not touched");
    await assert.rejects(new Integration(f.board, f.data).openPullRequest(f.board.getCard(card.id)!, "x".repeat(64), new GitHub(join(f.dir, "no-such-dir", "gh"))), /GitHub CLI unavailable/);

    await f.sync.syncBoard(f.repoBoard.id);
    assert.equal(f.board.getBoard(f.repoBoard.id)!.integrationError, "", "a good sync clears the error");
    assert.equal(f.board.getCard(card.id)?.status, "failed");
  } finally { f.cleanup(); }
});

test("main fast-forward: clean main fast-forwards; dirty, diverged, or not-checked-out main is left alone and pauses pickup", async () => {
  const f = fixture();
  try {
    const tip = f.landUpstream("a.txt");
    await f.sync.syncBoard(f.repoBoard.id);
    assert.equal(git(f.repo, "rev-parse", "main"), tip, "clean fast-forward");
    assert.equal(await fastForwardMain(f.repo), false, "already current");

    // Dirty: tracked change on main.
    f.landUpstream("b.txt");
    writeFileSync(join(f.repo, "README.md"), "local edit\n");
    await f.sync.syncBoard(f.repoBoard.id);
    let error = f.board.getBoard(f.repoBoard.id)!.integrationError;
    assert.match(error, /uncommitted changes \(README\.md\)/);
    assert.equal(git(f.repo, "rev-parse", "main"), tip);
    assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "local edit\n", "nothing stashed or reset");

    // Pickup pauses while the board has an integration error.
    const repoBoard = f.board.setAutoPickup(f.repoBoard.id, true, 1, 5);
    const waiting = f.board.createCard({ title: "Waiting", body: "", repo: f.repo });
    f.board.setStatus(waiting.id, "ready");
    assert.ok(f.board.getBoard(repoBoard.id)!.integrationError);
    assert.deepEqual(f.board.listAutoPickupCandidates().map(item => item.card.id), []);
    assert.throws(() => f.board.claim(waiting.id, "auto"), /not eligible/);
    git(f.repo, "checkout", "--", "README.md");

    // Diverged: a local commit on main.
    writeFileSync(join(f.repo, "local.txt"), "local\n"); git(f.repo, "add", "local.txt"); git(f.repo, ...commitArgs, "local commit");
    const local = git(f.repo, "rev-parse", "main");
    await f.sync.syncBoard(f.repoBoard.id);
    error = f.board.getBoard(f.repoBoard.id)!.integrationError;
    assert.match(error, /Local main has diverged from origin\/main \(1 local commit, 1 behind\)/);
    assert.equal(git(f.repo, "rev-parse", "main"), local, "no reset or rebase");
    git(f.repo, "reset", "-q", "--hard", tip);

    // Not checked out: the root is on another branch.
    git(f.repo, "checkout", "-q", "-b", "scratch");
    await f.sync.syncBoard(f.repoBoard.id);
    assert.match(f.board.getBoard(f.repoBoard.id)!.integrationError, /on branch scratch, not main/);
    assert.equal(git(f.repo, "rev-parse", "main"), tip);
    git(f.repo, "checkout", "-q", "main");

    await f.sync.syncBoard(f.repoBoard.id);
    assert.equal(f.board.getBoard(f.repoBoard.id)!.integrationError, "");
    assert.equal(git(f.repo, "rev-parse", "main"), git(f.repo, "rev-parse", "origin/main"));
    assert.deepEqual(f.board.listAutoPickupCandidates().map(item => item.card.id), [waiting.id], "pickup resumes once main is back in step");
  } finally { f.cleanup(); }
});

test("github-pr: a retry of an unpushed card whose base is behind is rebased onto origin/main before Pi starts", async () => {
  const f = fixture();
  try {
    const card = await reviewedCard(f);
    const worktree = join(f.data, "worktrees", card.id);
    // Commit the attempt so the worktree is clean, as after the operator commits it; then origin moves on.
    git(worktree, "add", "-A"); git(worktree, ...commitArgs, "attempt one");
    const tip = f.landUpstream("moved.txt");
    f.board.setStatus(card.id, "ready");
    const run = new Worker(f.board, f.data, f.fakePi).start(f.board.getCard(card.id)!);
    await waitFor(() => f.board.getRun(run.id)?.status !== "running");
    assert.equal(f.board.getRun(run.id)?.status, "review");
    assert.match(f.board.getRun(run.id)!.output, /Rebasing the card branch onto origin\/main/);
    assert.equal(git(worktree, "rev-parse", "HEAD~1"), tip);

    // A conflicting origin/main fails the retry for the operator and leaves the branch unchanged.
    // The fake Pi rewrote the same feature.txt, so the worktree is clean again.
    const before = git(worktree, "rev-parse", "HEAD");
    git(f.upstream, "pull", "-q", "--ff-only", "origin", "main");
    writeFileSync(join(f.upstream, "feature.txt"), "conflicting\n"); git(f.upstream, "add", "feature.txt"); git(f.upstream, ...commitArgs, "conflict"); git(f.upstream, "push", "-q", "origin", "main");
    f.board.setStatus(card.id, "ready");
    const conflicted = new Worker(f.board, f.data, f.fakePi).start(f.board.getCard(card.id)!);
    assert.equal(conflicted.status, "failed");
    assert.match(conflicted.error ?? "", /Rebase onto origin\/main conflicted in feature\.txt; the card branch is unchanged/);
    assert.equal(git(worktree, "rev-parse", "HEAD"), before);
    assert.equal(f.board.getCard(card.id)?.status, "failed");
  } finally { f.cleanup(); }
});

// Worktrunk itself, when installed: `wt remove` cleans up a squash-merged card and `wt step rebase` rebases a retry.
test("github-pr with Worktrunk: wt removes a squash-merged Done card and rebases an unpushed retry", { skip: !hasWorktrunk("wt") && "wt is not installed" }, async () => {
  const f = fixture("wt");
  try {
    const retried = await reviewedCard(f, "Retry");
    const retryTree = join(f.data, "worktrees", retried.id);
    git(retryTree, "add", "-A"); git(retryTree, ...commitArgs, "attempt one");
    const tip = f.landUpstream("moved.txt");
    f.board.setStatus(retried.id, "ready");
    const run = new Worker(f.board, f.data, f.fakePi, "wt").start(f.board.getCard(retried.id)!);
    await waitFor(() => f.board.getRun(run.id)?.status !== "running");
    assert.equal(f.board.getRun(run.id)?.status, "review", f.board.getRun(run.id)?.error ?? "");
    assert.equal(git(retryTree, "rev-parse", "HEAD~1"), tip, "wt step rebase put the attempt on origin/main");

    const card = await reviewedCard(f);
    const worktree = join(f.data, "worktrees", card.id);
    await approve(f, card.id);
    const [pr] = f.prs().filter(item => item.headRefName === `bakery/${card.id}`);
    const merge = f.squashMerge(`bakery/${card.id}`);
    f.setPrs([{ ...pr, state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: merge } }]);
    await f.sync.syncBoard(f.repoBoard.id);
    assert.equal(f.board.getCard(card.id)?.status, "done", f.board.getBoard(f.repoBoard.id)?.integrationError);
    assert.equal(existsSync(worktree), false, "wt removed the worktree");
    assert.equal(git(f.repo, "branch", "--list", `bakery/${card.id}`), "", "wt force-deleted the squash-merged branch");
    assert.equal(git(f.repo, "rev-parse", "main"), merge);
  } finally { f.cleanup(); }
});

test("checks: only the newest run of each check counts, and cancelled checks are not sent to the agent", () => {
  const rollup = (statusCheckRollup: PullRequest["statusCheckRollup"]) => ({ statusCheckRollup });
  const run = (name: string, conclusion: string, startedAt: string) => ({ __typename: "CheckRun", name, workflowName: "CI", status: "COMPLETED", conclusion, startedAt });
  assert.equal(checksState(rollup([run("pr-body", "CANCELLED", "2026-01-01T00:00:00Z"), run("pr-body", "SUCCESS", "2026-01-01T00:01:00Z")])), "passing");
  assert.equal(checksState(rollup([run("lint", "SUCCESS", "2026-01-01T00:00:00Z"), run("lint", "FAILURE", "2026-01-01T00:01:00Z")])), "failing");
  assert.equal(checksState(rollup([{ status: "IN_PROGRESS", conclusion: "" }, { status: "COMPLETED", conclusion: "SUCCESS" }])), "pending", "unnamed checks are kept apart");
  const mixed = rollup([run("lint", "FAILURE", "2026-01-01T00:00:00Z"), run("deploy", "CANCELLED", "2026-01-01T00:00:00Z"), run("ok", "SUCCESS", "2026-01-01T00:00:00Z")]);
  assert.deepEqual(fixableFailures(mixed).map(check => check.name), ["lint"]);
  const log = "CI\tCheck\t\uFEFF2026-10-27T14:18:49.5588276Z ##[group]Run node check.ts\nCI\tCheck\t2026-10-27T14:18:51.5173558Z \u001b[36;1mDB test coverage: add a test\u001b[0m\nCI\tCheck\t2026-10-27T14:18:51.5231714Z ##[error]Process completed with exit code 1.\n";
  assert.equal(trimFailedLog(log), "DB test coverage: add a test\n##[error]Process completed with exit code 1.");
});

test("github-pr: a PR failing CI goes back to the agent with the failures, once per pushed commit", async () => {
  const f = fixture();
  const promptFile = join(f.dir, "prompt.txt");
  // This Pi records its prompt, then changes the work so the retry has something new to review.
  const fixPi = join(f.dir, "pi-fix");
  writeFileSync(fixPi, `#!/bin/sh\nfor last; do :; done\nprintf '%s' "$last" > "${promptFile}"\necho fixed >> feature.txt\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
  chmodSync(fixPi, 0o755);
  const started: string[] = [];
  const worker = new Worker(f.board, f.data, fixPi);
  const sync = new GitHubSync(f.board, f.data, f.github, undefined, 60_000, card => { started.push(card.id); return worker.start(card); });
  try {
    const card = await reviewedCard(f);
    await approve(f, card.id);
    const [pr] = f.prs();
    const pushed = git(f.origin, "rev-parse", `refs/heads/bakery/${card.id}`);
    const done = new Date(Date.now() - 1000).toISOString();
    const lint = { __typename: "CheckRun", name: "lint", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", startedAt: done, completedAt: done, detailsUrl: "https://github.com/acme/widgets/actions/runs/1/job/55" };
    writeFileSync(join(f.ghDir, "job-55.log"), "CI\tlint\t2026-10-27T14:18:51.5173558Z feature.txt: missing newline\n");

    // Another check still running: wait so the agent gets every failure at once.
    f.setPrs([{ ...pr, headRefOid: pushed, statusCheckRollup: [lint, { name: "test", workflowName: "CI", status: "IN_PROGRESS", conclusion: "" }] }]);
    await sync.syncBoard(f.repoBoard.id);
    assert.deepEqual(started, []);
    assert.equal(f.board.getCard(card.id)!.prChecks, "failing");

    f.setPrs([{ ...pr, headRefOid: pushed, statusCheckRollup: [lint, { ...lint, name: "test", conclusion: "SUCCESS", detailsUrl: "" }] }]);
    await sync.syncBoard(f.repoBoard.id);
    assert.deepEqual(started, [card.id]);
    await waitFor(() => f.board.getCard(card.id)!.status === "review");
    const latest = f.board.listRuns(card.id)[0]; assert.equal(latest.status, "review", `${latest.error} ${latest.output}`);
    const prompt = readFileSync(promptFile, "utf8");
    assert.match(prompt, new RegExp(`failed CI at ${pushed}`));
    assert.match(prompt, /### CI \/ lint: failure\nhttps:\/\/github.com\/acme\/widgets\/actions\/runs\/1\/job\/55\n\n```\nfeature.txt: missing newline\n```/);
    assert.doesNotMatch(prompt, /CI \/ test/, "passing checks are left out");
    let current = f.board.getCard(card.id)!;
    assert.equal(current.ciReworks, 1);
    assert.equal(f.board.getCiFeedback(card.id), undefined, "the failures went to that run");

    // The same commit is not sent back twice, even though the PR still shows it failing.
    await sync.syncBoard(f.repoBoard.id);
    assert.deepEqual(started, [card.id]);
    assert.equal(f.board.getCard(card.id)!.prError, null);

    // Approving the fix pushes to the same PR, and a new failure sends it back again.
    const updated = await approve(f, card.id);
    assert.equal(updated.prNumber, 100);
    assert.equal(f.prs().length, 1, "the open PR was reused");
    const fixed = git(f.origin, "rev-parse", `refs/heads/bakery/${card.id}`);
    assert.notEqual(fixed, pushed);
    f.setPrs([{ ...pr, headRefOid: fixed, statusCheckRollup: [lint] }]);
    await sync.syncBoard(f.repoBoard.id);
    assert.deepEqual(started, [card.id, card.id]);
    await waitFor(() => f.board.getCard(card.id)!.status === "review");
    current = f.board.getCard(card.id)!;
    assert.equal(current.ciReworks, 2);
  } finally { f.cleanup(); }
});

test("github-pr: CI fix runs retry a start that failed, stop at the limit, and leave work the operator is changing alone", async () => {
  const f = fixture();
  const started: string[] = [];
  let refuse = false;
  const sync = new GitHubSync(f.board, f.data, f.github, undefined, 60_000, card => {
    if (refuse) throw new Error("Repository is at its 1-run concurrency limit");
    started.push(card.id);
  });
  try {
    const card = await reviewedCard(f);
    await approve(f, card.id);
    const [pr] = f.prs();
    const pushed = git(f.origin, "rev-parse", `refs/heads/bakery/${card.id}`);
    const done = new Date(Date.now() - 1000).toISOString();
    const lint = { name: "lint", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", startedAt: done, completedAt: done, detailsUrl: "https://ci.example/lint" };
    f.setPrs([{ ...pr, headRefOid: pushed, statusCheckRollup: [lint] }]);

    // Uncommitted work in the card worktree: someone is already on it.
    const worktree = join(f.data, "worktrees", card.id);
    writeFileSync(join(worktree, "scratch.txt"), "wip\n");
    await sync.syncBoard(f.repoBoard.id);
    assert.deepEqual(started, []);
    rmSync(join(worktree, "scratch.txt"));

    refuse = true;
    await sync.syncBoard(f.repoBoard.id);
    assert.match(f.board.getCard(card.id)!.prError ?? "", /could not start a fix run yet: Repository is at its 1-run concurrency limit/);
    refuse = false;
    await sync.syncBoard(f.repoBoard.id);
    assert.deepEqual(started, [card.id], "the next sync started it");
    assert.equal(f.board.getCard(card.id)!.ciReworks, 1, "a retried start is the same round");
    // The fake rework does not run Pi, so the failures are still waiting. A rerun that passes drops them.
    f.setPrs([{ ...pr, headRefOid: pushed, statusCheckRollup: [lint, { ...lint, startedAt: new Date().toISOString(), conclusion: "SUCCESS" }] }]);
    await sync.syncBoard(f.repoBoard.id);
    assert.equal(f.board.getCiFeedback(card.id), undefined, "stale failures are dropped once CI passes");
    assert.equal(f.board.getCard(card.id)!.prChecks, "passing");
    assert.deepEqual(started, [card.id]);

    // A new pushed commit that fails again, with the limit used up: the card stays in Review with the reason.
    f.setPrs([{ ...pr, headRefOid: pushed, statusCheckRollup: [{ ...lint, startedAt: new Date(Date.now() + 1000).toISOString() }] }]);
    const db = new DatabaseSync(join(f.dir, "board.sqlite"));
    try { db.prepare("UPDATE cards SET ciReworks=?, ciReworkSha='0000' WHERE id=?").run(maxCiReworks, card.id); } finally { db.close(); }
    await sync.syncBoard(f.repoBoard.id);
    assert.deepEqual(started, [card.id]);
    assert.match(f.board.getCard(card.id)!.prError ?? "", /after 3 automatic fix runs/);
    await sync.syncBoard(f.repoBoard.id);
    assert.match(f.board.getCard(card.id)!.prError ?? "", /after 3 automatic fix runs/, "the reason stays on the card");
  } finally { f.cleanup(); }
});
