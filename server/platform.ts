import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

/**
 * Finds `bin` the way Windows would: each PATH entry, trying every PATHEXT extension.
 * Node can't spawn a bare name like `pi` there, because npm installs `pi.cmd`.
 */
function findOnWindows(
  bin: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const pathExt = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  // The bare name counts only when it already carries an executable extension. npm also installs an extensionless
  // `pi` sh script beside `pi.cmd`, and Windows cannot spawn it.
  const exts = pathExt.some(
    (ext) => ext.toLowerCase() === extname(bin).toLowerCase(),
  )
    ? ["", ...pathExt]
    : pathExt;
  const dirs =
    /[\\/]/.test(bin) || isAbsolute(bin)
      ? [""]
      : (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  for (const dir of dirs)
    for (const ext of exts) {
      const candidate = dir ? join(dir, bin + ext) : bin + ext;
      if (existsSync(candidate)) return candidate;
    }
  return undefined;
}

/** The JavaScript file an npm `.cmd` shim runs, e.g. `"%dp0%\node_modules\pkg\dist\cli.js"`. */
function shimScript(shim: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return undefined;
  }
  const relative = /"%(?:~dp0|dp0%)[\\/]?([^"%]+?\.[cm]?js)"/i.exec(text)?.[1];
  if (!relative) return undefined;
  const script = resolve(dirname(shim), relative.replaceAll("\\", "/"));
  return existsSync(script) ? script : undefined;
}

/**
 * Command and arguments to pass to spawn/execFile for `bin`. Unchanged off Windows.
 * On Windows an npm `.cmd` shim becomes `node script.js ...`, because Node refuses to spawn
 * `.cmd` files without a shell and a shell would mangle prompts containing quotes and newlines.
 */
export function command(
  bin: string,
  args: string[],
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): [string, string[]] {
  if (platform !== "win32") return [bin, args];
  const file = findOnWindows(bin, env);
  if (!file) return [bin, args];
  if (!/\.(cmd|bat)$/i.test(file)) return [file, args];
  const script = shimScript(file);
  return script ? [process.execPath, [script, ...args]] : [file, args];
}

/**
 * The POSIX shell for user-written command lines (a board's verification command) and Git hooks: `/bin/sh` off
 * Windows, the `sh.exe` that ships with Git for Windows there. Undefined on Windows when none is found.
 */
export function posixShell(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (platform !== "win32") return "/bin/sh";
  const onPath = findOnWindows("sh", env);
  if (onPath) return onPath;
  // Git for Windows often puts only `<root>\\cmd` on PATH. Look beside the git.exe that PATH resolves, wherever it was installed.
  const roots: string[] = [];
  const git = findOnWindows("git", env);
  if (git) {
    let dir = dirname(git);
    for (let i = 0; i < 3; i++, dir = dirname(dir)) roots.push(dir);
  }
  for (const root of [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LocalAppData && join(env.LocalAppData, "Programs"),
  ])
    if (root) roots.push(join(root, "Git"));
  for (const root of roots)
    for (const rel of ["bin", join("usr", "bin")])
      if (existsSync(join(root, rel, "sh.exe")))
        return join(root, rel, "sh.exe");
  return undefined;
}

/**
 * Every process descended from `root`, found through the parent ids Windows keeps on orphans. The root may already be
 * gone: a parent that exits while its descendants hold the output pipes is exactly the case that needs this.
 */
function windowsDescendants(root: number): number[] {
  const table = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const children = new Map<number, number[]>();
  for (const line of (table.stdout ?? "").split(/\r?\n/)) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (!pid || !parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length) {
    for (const pid of children.get(queue.shift()!) ?? []) {
      if (pid === root || found.includes(pid)) continue;
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

/** Kills a Windows process and its descendants, including ones orphaned by a parent that already exited. */
export function killWindowsTree(pid: number): void {
  const victims = [...windowsDescendants(pid), pid];
  for (const victim of victims)
    spawnSync("taskkill", ["/pid", String(victim), "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
}

/**
 * Stops a child and everything it started. `child.kill()` on Windows ends only that one process, so a tool the agent
 * was running (a test runner, a dev server) would outlive the run and hold its worktree open. Descendants are found by
 * parent id, so this works after the child itself has exited, and the pipes are closed so `close` still fires.
 * Elsewhere this is `child.kill(signal)`.
 */
export function killTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  platform: string = process.platform,
): boolean {
  if (platform === "win32" && child.pid) {
    // True when there was something to stop, as `child.kill()` reports; the child is already gone once taskkill returns.
    const wasRunning = child.exitCode === null && child.signalCode === null;
    killWindowsTree(child.pid);
    child.stdout?.destroy();
    child.stderr?.destroy();
    return wasRunning || child.kill(signal);
  }
  return child.kill(signal);
}
