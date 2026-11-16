import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telemetry, doctorCheck, errorType, runOutcome } from "../server/telemetry.js";

type Sent = { url: string; body: any };
const fakePost = (sent: Sent[]) => async (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };

/** Every key and value in a payload, so a leak of anything unlisted shows up. */
function walk(value: unknown, keys: Set<string> = new Set(), leaves: unknown[] = []) {
  if (Array.isArray(value)) value.forEach(item => walk(item, keys, leaves));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { keys.add(key); walk(item, keys, leaves); }
  else leaves.push(value);
  return { keys, leaves };
}

test("with telemetry off and an endpoint set, nothing is sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-telemetry-")), sent: Sent[] = [];
  try {
    const telemetry = new Telemetry({ endpoint: "http://telemetry.test", enabled: () => false, dataDir: dir, version: "1.2.3", post: fakePost(sent) });
    telemetry.count("bakery.runs.started"); telemetry.count("bakery.server.errors", { "error.type": "Error" });
    await telemetry.flush(); await telemetry.shutdown();
    assert.deepEqual(sent, []);
    assert.equal(telemetry.available, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("counts gathered before telemetry was turned off are not sent after it is turned on again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-telemetry-")), sent: Sent[] = [];
  try {
    let on = true;
    const telemetry = new Telemetry({ endpoint: "http://telemetry.test", enabled: () => on, dataDir: dir, version: "1.2.3", post: fakePost(sent) });
    telemetry.count("bakery.runs.started");
    on = false; telemetry.discard(); on = true;
    telemetry.count("bakery.merges");
    await telemetry.flush();
    assert.deepEqual(sent[0].body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: any) => m.name), ["bakery.merges"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shutdown sends counts queued while an earlier send was in flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-telemetry-")), sent: Sent[] = [];
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const post = async (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); if (first) { first = false; await gate; } return { ok: true, status: 200 }; };
    const telemetry = new Telemetry({ endpoint: "http://telemetry.test", enabled: () => true, dataDir: dir, version: "1.2.3", post });
    telemetry.count("bakery.runs.started");
    const inFlight = telemetry.flush();
    telemetry.count("bakery.runs.stopped");
    const done = telemetry.shutdown(5_000);
    release();
    await Promise.all([inFlight, done]);
    assert.deepEqual(sent.map(item => item.body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: any) => m.name)), [["bakery.runs.started"], ["bakery.runs.stopped"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("without an endpoint telemetry is unavailable and sends nothing even when enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-telemetry-")), sent: Sent[] = [];
  try {
    for (const endpoint of [undefined, "", "  "]) {
      const telemetry = new Telemetry({ endpoint, enabled: () => true, dataDir: dir, version: "1", post: fakePost(sent) });
      telemetry.count("bakery.runs.started"); await telemetry.flush();
      assert.equal(telemetry.available, false);
    }
    assert.deepEqual(sent, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with telemetry on, the payload holds only the listed fields, batched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-telemetry-")), sent: Sent[] = [];
  try {
    const telemetry = new Telemetry({ endpoint: "http://telemetry.test/", enabled: () => true, dataDir: dir, version: "1.2.3", platform: "linux", post: fakePost(sent) });
    telemetry.count("bakery.runs.started"); telemetry.count("bakery.runs.started");
    telemetry.count("bakery.runs.failed"); telemetry.count("bakery.merges");
    telemetry.count("bakery.doctor.failures", { "doctor.check": "git" });
    telemetry.count("bakery.server.errors", { "error.type": "TypeError" });
    await telemetry.flush();
    assert.equal(sent.length, 1, "one batch");
    assert.equal(sent[0].url, "http://telemetry.test/v1/metrics");
    const { resourceMetrics: [resource] } = sent[0].body;
    const id = readFileSync(join(dir, "telemetry-id"), "utf8").trim();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.deepEqual(resource.resource.attributes.map((a: any) => [a.key, a.value.stringValue]), [["service.name", "bakery"], ["service.version", "1.2.3"], ["os.type", "linux"], ["bakery.install.id", id]]);
    const metrics = resource.scopeMetrics[0].metrics;
    assert.deepEqual(metrics.map((m: any) => [m.name, m.sum.dataPoints.map((p: any) => p.asInt)]), [["bakery.runs.started", ["2"]], ["bakery.runs.failed", ["1"]], ["bakery.merges", ["1"]], ["bakery.doctor.failures", ["1"]], ["bakery.server.errors", ["1"]]]);
    assert.deepEqual(metrics[3].sum.dataPoints[0].attributes, [{ key: "doctor.check", value: { stringValue: "git" } }]);
    assert.deepEqual(metrics[4].sum.dataPoints[0].attributes, [{ key: "error.type", value: { stringValue: "TypeError" } }]);
    const { keys } = walk(sent[0].body);
    const allowed = ["resourceMetrics", "resource", "attributes", "key", "value", "stringValue", "scopeMetrics", "scope", "name", "metrics", "sum", "aggregationTemporality", "isMonotonic", "dataPoints", "startTimeUnixNano", "timeUnixNano", "asInt"];
    assert.deepEqual([...keys].filter(key => !allowed.includes(key)), []);
    // The install ID is kept: a second instance on the same data directory reuses it.
    const again = new Telemetry({ endpoint: "http://telemetry.test", enabled: () => true, dataDir: dir, version: "1.2.3", post: fakePost(sent) });
    again.count("bakery.merges"); await again.flush();
    assert.equal(sent[1].body.resourceMetrics[0].resource.attributes[3].value.stringValue, id);
    // An empty window sends nothing.
    await telemetry.flush(); assert.equal(sent.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failing endpoint never throws or blocks, and the counts are dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-telemetry-")); let calls = 0;
  try {
    const telemetry = new Telemetry({ endpoint: "http://telemetry.test", enabled: () => true, dataDir: dir, version: "1", post: async () => { calls++; throw new Error("connect ECONNREFUSED"); } });
    telemetry.count("bakery.merges"); await telemetry.flush();
    await telemetry.flush();
    assert.equal(calls, 1);
    const broken = new Telemetry({ endpoint: "http://telemetry.test", enabled: () => { throw new Error("db closed"); }, dataDir: dir, version: "1", post: async () => { calls++; return { ok: true, status: 200 }; } });
    broken.count("bakery.merges"); await broken.flush();
    assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run outcomes, error types and doctor check names are reduced to the listed values", () => {
  assert.equal(runOutcome({ status: "review", error: null }), "bakery.runs.finished");
  assert.equal(runOutcome({ status: "failed", error: "Pi exited (SIGTERM); Bakery sent SIGTERM: manual stop; settled" }), "bakery.runs.stopped");
  assert.equal(runOutcome({ status: "failed", error: "Pi exited (1)" }), "bakery.runs.failed");
  assert.equal(runOutcome({ status: "interrupted", error: null }), null);
  class Weird extends Error {}
  assert.equal(errorType(new TypeError("/home/me/secret")), "TypeError");
  assert.equal(errorType(new Weird()), "Weird");
  assert.equal(errorType("/home/me/secret"), "Error");
  assert.equal(doctorCheck("board /home/me/repo"), "board");
  assert.equal(doctorCheck("git identity"), "git identity");
  assert.equal(doctorCheck("/home/me/other"), undefined);
});

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

test("the server sends only counts once the Settings toggle is on, and nothing before", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-telemetry-api-")), repo = join(home, "secret-repo-name");
  mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
  const received: string[] = [];
  const bodies = () => received as readonly string[];
  const sink = createHttpServer((req, res) => { let text = ""; req.on("data", chunk => { text += chunk; }); req.on("end", () => { received.push(text); res.end("{}"); }); });
  await new Promise<void>(resolve => sink.listen(0, "127.0.0.1", resolve));
  const port = await freePort();
  const start = (endpoint: string | undefined) => spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: join(home, "data"), BAKERY_PORT: String(port), BAKERY_TELEMETRY_ENDPOINT: endpoint ?? "" },
  });
  const url = `http://127.0.0.1:${port}/api`;
  const call = async (path: string, method = "GET", input?: unknown) => { const r = await fetch(url + path, { method, headers: input ? { "Content-Type": "application/json" } : undefined, body: input ? JSON.stringify(input) : undefined }); return { status: r.status, data: await r.json() as any }; };
  const up = async (child: ReturnType<typeof start>) => { const deadline = Date.now() + 8000; while (true) { try { await fetch(`${url}/boards`); return; } catch { if (Date.now() > deadline || child.exitCode !== null) throw new Error("server did not start"); await new Promise(r => setTimeout(r, 25)); } } };
  const stop = (child: ReturnType<typeof start>) => new Promise<void>(resolve => { child.once("close", () => resolve()); if (process.platform === "win32") child.send({ type: "shutdown" }); else child.kill("SIGTERM"); });
  try {
    // No endpoint: hidden and refused.
    let child = start(undefined); await up(child);
    assert.equal((await call("/settings")).data.telemetryAvailable, false);
    assert.equal((await call("/settings", "PATCH", { telemetryEnabled: true })).status, 400);
    await stop(child);

    // Endpoint set, toggle off by default: events happen, nothing is sent.
    child = start(`http://127.0.0.1:${(sink.address() as { port: number }).port}`); await up(child);
    const settings = (await call("/settings")).data;
    assert.equal(settings.telemetryAvailable, true); assert.equal(settings.telemetryEnabled, false);
    await call("/settings", "PATCH", {}); await call("/telemetry/doctor", "POST", { checks: ["git"] });
    await stop(child);
    assert.equal(bodies().length, 0);

    // Turned on: errors and doctor failures are counted and flushed at shutdown.
    child = start(`http://127.0.0.1:${(sink.address() as { port: number }).port}`); await up(child);
    assert.equal((await call("/settings", "PATCH", { telemetryEnabled: true })).data.telemetryEnabled, true);
    await call("/settings", "PATCH", {});
    await call("/telemetry/doctor", "POST", { checks: ["git", "board " + repo, repo] });
    await call("/boards", "POST", { repo });
    assert.equal((await call("/boards/missing/cards")).status, 404);
    assert.equal((await call("/boards/missing/cards")).status, 404);
    await stop(child);
    assert.equal(bodies().length, 1);
    const body = JSON.parse(received[0]);
    const metrics = Object.fromEntries(body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: any) => [m.name, m.sum.dataPoints.map((p: any) => [p.attributes.map((a: any) => a.value.stringValue).join(), p.asInt])]));
    assert.deepEqual(metrics, { "bakery.doctor.failures": [["git", "1"], ["board", "1"]], "bakery.server.errors": [["Error", "1"], ["Http404", "2"]] });
    assert.equal(bodies()[0].includes(repo), false); assert.equal(bodies()[0].includes("secret-repo-name"), false);
    assert.equal(bodies()[0].includes(home), false);
  } finally { sink.close(); rmSync(home, { recursive: true, force: true }); }
});
