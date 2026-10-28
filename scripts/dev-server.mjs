#!/usr/bin/env node
// Dev supervisor for the Bakery server. Replaces `tsx watch`, which SIGTERMs the
// server on any source change and so killed every running Pi child whenever
// Bakery integrated a card into its own checkout. Here a change first asks the
// server to drain (no new runs, wait for active ones), then restarts it.
import { spawn } from "node:child_process";
import { watch, readFileSync } from "node:fs";
import { createServer, request } from "node:http";

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
let ready = false; // the server child is accepting requests
let changeAt = 0; // when the pending restart was requested
let activeRuns = 0;
let bootMs = Number(process.env.BAKERY_BOOT_ESTIMATE_MS) || 6000; // last measured spawn-to-listening time
let retryAt = 0;

// The supervisor owns the public port and proxies to the server on an internal one, so a page load during a
// restart gets a static status page with timing instead of a refused connection.
const publicPort = Number(process.env.BAKERY_PORT ?? 4317);
const innerPort = Number(process.env.BAKERY_INNER_PORT ?? publicPort + 10000);
const page = () => readFileSync(new URL("./restart-page.html", import.meta.url), "utf8");

function state() {
  const phase = ready ? (draining ? "draining" : "up") : retry ? "crashed" : child ? "starting" : "restarting";
  return { phase, activeRuns, now: Date.now(), changeAt, startedAt, bootMs, retryAt };
}

const front = createServer((req, res) => {
  if (req.url === "/__bakery/state") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(state()));
    return;
  }
  const unavailable = () => {
    if (res.headersSent) { res.destroy(); return; }
    const html = req.method === "GET" && String(req.headers.accept).includes("text/html");
    res.writeHead(503, { "content-type": html ? "text/html; charset=utf-8" : "application/json", "retry-after": "2", "cache-control": "no-store" });
    res.end(html ? page() : JSON.stringify({ error: "Bakery is restarting" }));
  };
  if (!ready) { unavailable(); return; }
  const upstream = request({ host: "127.0.0.1", port: innerPort, path: req.url, method: req.method, headers: req.headers }, answer => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on("error", unavailable);
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});
front.listen(publicPort, "127.0.0.1", () => log(`Listening on http://127.0.0.1:${publicPort} (server on ${innerPort})`));

function log(message) { console.log(`[dev-server] ${message}`); }

function start() {
  clearTimeout(retry); retry = null;
  draining = false; ready = false; retryAt = 0; startedAt = Date.now();
  child = spawn(process.execPath, ["--import", "tsx", entry], { stdio: ["inherit", "inherit", "inherit", "ipc"], env: { ...process.env, BAKERY_PORT: String(innerPort) } });
  child.on("message", message => {
    if (message?.type === "listening") { ready = true; bootMs = Date.now() - startedAt; }
    if (message?.type === "draining") activeRuns = message.activeRuns;
    if (message?.type === "draining" && message.activeRuns > 0)
      log(`Code changed; waiting for ${message.activeRuns} active run(s) to finish before restarting. New runs are refused until then.`);
    if (message?.type === "drained" && child) { log("Restarting server…"); child.kill("SIGTERM"); }
  });
  child.on("exit", (code, signal) => {
    const restart = draining && !stopping;
    child = null; ready = false;
    if (stopping) process.exit(code ?? 0);
    if (restart) { crashes = 0; start(); return; }
    // A server that ran for a while counts as a fresh failure; quick repeats back off up to 30s.
    crashes = Date.now() - startedAt > 30_000 ? 1 : crashes + 1;
    const delay = Math.min(1000 * 2 ** (crashes - 1), 30_000);
    log(`Server exited (${signal ?? code}); restarting in ${delay / 1000}s, or sooner on a file change.`);
    retryAt = Date.now() + delay;
    retry = setTimeout(start, delay);
  });
}

function changed() {
  if (!child) { start(); return; }
  if (draining) return; // the restart after this drain loads every change so far
  draining = true; changeAt = Date.now();
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
