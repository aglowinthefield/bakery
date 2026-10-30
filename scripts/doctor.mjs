// `bakery-cli doctor`: checks the tools, data directory, server and boards Bakery depends on.
// Local checks describe the machine running the CLI; board repository checks only run when the
// server is on this machine, because a remote server's paths are on its own disk.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Bare names like `pi` are npm `.cmd` shims on Windows, which only a shell can run.
function run(bin, args, timeout = 20_000) {
  const result = spawnSync(bin, args, { encoding: "utf8", timeout, shell: process.platform === "win32", env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error?.code === "ENOENT" || (process.platform === "win32" && result.status !== 0 && /not recognized/.test(output))) return { missing: true, ok: false, output };
  if (result.error) return { ok: false, output: result.error.message };
  return { ok: result.status === 0, output };
}

const firstLine = text => text.split("\n").find(line => line.trim())?.trim() ?? "";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function nodeCheck() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 24 ? { status: "pass", name: "node", detail: `v${process.versions.node}` }
    : { status: "fail", name: "node", detail: `v${process.versions.node}; Bakery needs Node 24 or newer` };
}

function gitChecks() {
  const version = run("git", ["--version"]);
  if (!version.ok) return [{ status: "fail", name: "git", detail: version.missing ? "git not found on PATH" : firstLine(version.output) }];
  // Approve commits on the card branch, so git needs an identity to commit with.
  const ident = run("git", ["var", "GIT_COMMITTER_IDENT"]);
  return [
    { status: "pass", name: "git", detail: firstLine(version.output) },
    ident.ok ? { status: "pass", name: "git identity", detail: firstLine(ident.output).replace(/>.*$/, ">") }
      : { status: "fail", name: "git identity", detail: "git has no committer name or email; set git config --global user.name and user.email" },
  ];
}

function piChecks(env) {
  const bin = env.BAKERY_PI_BIN ?? "pi";
  const version = run(bin, ["--version"]);
  if (!version.ok) return [{ status: "fail", name: "pi", detail: version.missing ? `${bin} not found; install Pi or set BAKERY_PI_BIN` : `${bin} --version failed: ${firstLine(version.output)}` }];
  const list = run(bin, ["--list-models"], 60_000);
  // Same table shape the server parses: a "provider model ..." header, then one model per line.
  const models = list.ok ? list.output.split("\n").map(line => line.trim().split(/\s+/)).filter(([provider, model]) => provider && model && provider !== "provider") : [];
  return [
    { status: "pass", name: "pi", detail: `${bin} ${firstLine(version.output)}` },
    models.length ? { status: "pass", name: "pi models", detail: `${models.length} available` }
      : { status: "fail", name: "pi models", detail: list.ok ? "pi lists no models; configure a provider in Pi" : `${bin} --list-models failed: ${firstLine(list.output)}` },
  ];
}

function wtCheck(env) {
  const bin = env.BAKERY_WT_BIN ?? "wt";
  if (!bin) return { status: "pass", name: "worktrunk", detail: "turned off (BAKERY_WT_BIN is empty)" };
  const version = run(bin, ["--version"]);
  return version.ok ? { status: "pass", name: "worktrunk", detail: `${bin} ${firstLine(version.output)}` }
    : { status: "warn", name: "worktrunk", detail: `${bin} not usable; worktree hooks won't run (optional)` };
}

// gh only matters on GitHub pull request boards, so it fails only when one exists.
function ghCheck(env, boards) {
  const bin = env.BAKERY_GH_BIN || "gh";
  const needed = boards?.filter(board => board.integration === "github-pr").map(board => board.repo) ?? [];
  const problem = status => ({ status: needed.length ? "fail" : "warn", name: "gh", detail: `${status}; ${needed.length ? `needed by ${needed.join(", ")}` : "needed only for GitHub pull request boards"}` });
  const auth = run(bin, ["auth", "status"]);
  if (auth.missing) return problem(`${bin} not found`);
  if (!auth.ok) return problem(`gh auth status failed: ${firstLine(auth.output)}`);
  return { status: "pass", name: "gh", detail: "signed in" };
}

function dataDirChecks(env) {
  const dir = env.BAKERY_DATA_DIR ?? join(homedir(), ".local", "share", "bakery");
  let existing = dir;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  try { accessSync(existing, constants.W_OK); }
  catch { return [{ status: "fail", name: "data dir", detail: `${existing} is not writable (data dir ${dir})` }]; }
  const checks = [{ status: "pass", name: "data dir", detail: existing === dir ? dir : `${dir} (will be created)` }];
  const lock = join(dir, "server.lock");
  if (existsSync(lock)) {
    const pid = Number(/^\s*(\d+)\s*$/.exec(readFileSync(lock, "utf8"))?.[1]);
    checks.push(!pid ? { status: "warn", name: "server lock", detail: `${lock} has no PID; remove it if no server is starting` }
      : alive(pid) ? { status: "pass", name: "server lock", detail: `held by running PID ${pid}` }
      : { status: "pass", name: "server lock", detail: `stale lock from PID ${pid}; the next server takes it over` });
  }
  return checks;
}

function boardChecks(board, local) {
  const name = `board ${board.repo}`;
  if (local) {
    if (!existsSync(board.repo)) return [{ status: "fail", name, detail: "repository path does not exist; edit the board's path" }];
    const head = run("git", ["-C", board.repo, "rev-parse", "--verify", "HEAD"]);
    if (!head.ok) return [{ status: "fail", name, detail: "not a Git repository with a commit; worktrees start from HEAD" }];
  }
  const problems = [
    board.integrationError && { status: "fail", name, detail: `integration: ${board.integrationError}` },
    board.integrationWarning && { status: "warn", name, detail: `integration: ${board.integrationWarning}` },
    board.autoPickupError && { status: "warn", name, detail: `pickup paused: ${board.autoPickupError}` },
  ].filter(Boolean);
  return problems.length ? problems : [{ status: "pass", name, detail: `${board.integration ?? "local"} integration` }];
}

/** Runs every check. `fetchBoards` resolves to the server's boards or throws when it is unreachable. */
export async function doctor({ env = process.env, origin, local, fetchBoards }) {
  let boards = null, serverCheck;
  try {
    boards = await fetchBoards();
    serverCheck = { status: "pass", name: "server", detail: `${origin.origin} (${boards.length} board${boards.length === 1 ? "" : "s"})` };
  } catch (error) {
    serverCheck = { status: "fail", name: "server", detail: `${error instanceof Error ? error.message : error}; start it with npm start or npm run dev` };
  }
  // Tools, the data directory and repository paths belong to the machine the server runs on.
  const machine = local ? [nodeCheck(), ...gitChecks(), ...piChecks(env), wtCheck(env), ghCheck(env, boards), ...dataDirChecks(env)] : [];
  return [...machine, serverCheck, ...(boards ?? []).flatMap(board => boardChecks(board, local))];
}

export function report(checks) {
  const label = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const count = status => checks.filter(check => check.status === status).length;
  return [
    ...checks.map(check => `${label[check.status]}\t${check.name}\t${check.detail}`),
    `${count("pass")} passed, ${count("warn")} warnings, ${count("fail")} failed`,
  ];
}
