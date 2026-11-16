import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { chromium, webkit } from "playwright";
import { posixShell } from "../server/platform.js";

// Tests that spawn `server/index.ts` poll http://127.0.0.1:<port>. When the suite runs inside a Bakery agent, the
// environment carries Bakery's own remote-hosting settings, which would bind the test server to another address.
delete process.env.BAKERY_HOST;
delete process.env.BAKERY_ALLOWED_HOSTS;

// Loaded by `npm test` before every test file. Playwright waits 30s by default for a locator that never appears,
// and a UI test can wait several times, so one missing element stalled the suite for minutes. A wait that takes
// longer than 10s here, even with every test file running in parallel, means the element is not coming. Page loads
// keep 30s for a cold Vite server.
//
// On macOS the tests run in WebKit: headless Chromium falls back to software GPU rendering there and pegs every core.
// Tests keep calling `chromium.launch()`; set BAKERY_TEST_BROWSER=chromium (in the shell, or at the top of a test file
// that needs Chromium-only features such as clipboard permissions) to get real Chromium back.
const launchChromium = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const useWebkit = process.platform === "darwin" && process.env.BAKERY_TEST_BROWSER !== "chromium";
  const browser = await (useWebkit ? webkit.launch() : launchChromium(...args));
  const newContext = browser.newContext.bind(browser);
  // Browser.newPage creates its context through this, so pages opened either way get the limit.
  browser.newContext = async (...options) => {
    const context = await newContext(...options);
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(30_000);
    return context;
  };
  return browser;
};

// Fake `pi`, `wt` and `gh` binaries are `#!/bin/sh` or `#!/usr/bin/env node` scripts, which Windows cannot spawn.
// Tests make them executable with chmodSync, so on Windows that call also writes an npm-style `<name>.cmd` shim
// beside the script. `server/platform.ts` resolves a bare or absolute name to the shim and runs its `.cjs` target under
// node, which runs the script with Git's sh (or node itself). Git hooks need nothing: Git for Windows reads their shebang.
if (process.platform === "win32") {
  const chmodSync = fs.chmodSync;
  fs.chmodSync = (path: fs.PathLike, mode: fs.Mode) => {
    chmodSync(path, mode);
    const file = String(path);
    if (/\.(cmd|cjs)$/i.test(file) || /[\\/]hooks[\\/]/.test(file)) return;
    const shebang = /^#!(\S+)(?: (\S+))?/.exec(fs.readFileSync(file, "utf8").slice(0, 200));
    if (!shebang) return;
    const node = shebang[2] === "node" || shebang[1].endsWith("/node");
    const runner = node ? process.execPath : posixShell();
    if (!runner) throw new Error("Git for Windows' sh.exe is required to run the fake binaries in tests");
    // The wrapper relays output through itself instead of inheriting handles, so a test that kills the fake
    // leaves no orphaned `sleep` holding the server's pipes open.
    fs.writeFileSync(`${file}.cjs`, `const { spawn } = require("node:child_process");
const child = spawn(${JSON.stringify(runner)}, [${JSON.stringify(file)}, ...process.argv.slice(2)], { stdio: ["inherit", "pipe", "pipe"] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.on("close", code => process.exit(code ?? 1));
`);
    fs.writeFileSync(`${file}.cmd`, `@ECHO off\r\n"%~dp0\\${file.split(/[\\/]/).pop()}.cjs" %*\r\n`);
  };
  // A process that was just stopped can hold its working directory for a moment after Windows reports it gone, so
  // removing a test's temp directory right away fails with EPERM. Retrying is Node's documented answer; tests also
  // close their databases and wait for the servers they start before removing anything.
  // If the directory is still held after the retries, cleanup is abandoned with a warning: throwing from a test's
  // `finally` would replace the assertion that actually failed, and a leftover temp directory is harmless.
  const rmSync = fs.rmSync;
  fs.rmSync = ((path: fs.PathLike, options?: fs.RmOptions) => {
    if (!options?.recursive) return rmSync(path, options);
    try { rmSync(path, { maxRetries: 8, retryDelay: 100, ...options }); }
    catch (error) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      console.warn(`left ${String(path)} behind: ${(error as Error).message}`);
    }
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
}
