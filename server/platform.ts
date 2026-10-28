import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Finds `bin` the way Windows would: each PATH entry, trying every PATHEXT extension.
 * Node can't spawn a bare name like `pi` there, because npm installs `pi.cmd`.
 */
function findOnWindows(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)];
  const dirs = /[\\/]/.test(bin) || isAbsolute(bin) ? [""] : (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  for (const dir of dirs) for (const ext of exts) {
    const candidate = dir ? join(dir, bin + ext) : bin + ext;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The JavaScript file an npm `.cmd` shim runs, e.g. `"%dp0%\node_modules\pkg\dist\cli.js"`. */
function shimScript(shim: string): string | undefined {
  let text: string;
  try { text = readFileSync(shim, "utf8"); } catch { return undefined; }
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
export function command(bin: string, args: string[], platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (platform !== "win32") return [bin, args];
  const file = findOnWindows(bin, env);
  if (!file) return [bin, args];
  if (!/\.(cmd|bat)$/i.test(file)) return [file, args];
  const script = shimScript(file);
  return script ? [process.execPath, [script, ...args]] : [file, args];
}
