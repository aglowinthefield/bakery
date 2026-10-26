#!/usr/bin/env node
// Dev supervisor for the Bakery server. Replaces `tsx watch`, which SIGTERMs the
// server on any source change and so killed every running Pi child whenever
// Bakery integrated a card into its own checkout. Here a change first asks the
// server to drain (no new runs, wait for active ones), then restarts it.
import { spawn } from "node:child_process";
import { watch } from "node:fs";

const entry = "server/index.ts";
const watched = ["server", "src"];
const sourceFile = /\.(ts|tsx|mjs|js|json)$/;

let child = null;
let draining = false;
let stopping = false; // supervisor itself is shutting down
let debounce = null;
let retry = null; // pending restart after a crash
let crashes = 0; // consecutive quick crashes, for backoff
let startedAt = 0;

function log(message) { console.log(`[dev-server] ${message}`); }

function start() {
  clearTimeout(retry); retry = null;
  draining = false; startedAt = Date.now();
  child = spawn(process.execPath, ["--import", "tsx", entry], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
  child.on("message", message => {
    if (message?.type === "draining" && message.activeRuns > 0)
      log(`Code changed; waiting for ${message.activeRuns} active run(s) to finish before restarting. New runs are refused until then.`);
    if (message?.type === "drained" && child) { log("Restarting server…"); child.kill("SIGTERM"); }
  });
  child.on("exit", (code, signal) => {
    const restart = draining && !stopping;
    child = null;
    if (stopping) process.exit(code ?? 0);
    if (restart) { crashes = 0; start(); return; }
    // A server that ran for a while counts as a fresh failure; quick repeats back off up to 30s.
    crashes = Date.now() - startedAt > 30_000 ? 1 : crashes + 1;
    const delay = Math.min(1000 * 2 ** (crashes - 1), 30_000);
    log(`Server exited (${signal ?? code}); restarting in ${delay / 1000}s, or sooner on a file change.`);
    retry = setTimeout(start, delay);
  });
}

function changed() {
  if (!child) { start(); return; }
  if (draining) return; // the restart after this drain loads every change so far
  draining = true;
  if (child.connected) child.send({ type: "drain" });
  else child.kill("SIGTERM");
}

for (const dir of watched) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (!file || !sourceFile.test(file)) return;
    clearTimeout(debounce);
    debounce = setTimeout(changed, 300); // a Git fast-forward writes many files at once
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    clearTimeout(retry);
    if (child) child.kill(signal); else process.exit(0);
  });
}

start();
