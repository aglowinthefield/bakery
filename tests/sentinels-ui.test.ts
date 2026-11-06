import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const boards = [{ id: "gh", repo: "/tmp/gh", remoteUrl: "https://github.com/acme/gh", integration: "github-pr", autoCollapseEmptySwimlanes: false }];
const card = (id: string, title: string, status: string, idempotencyKey: string | null) =>
  ({ id, title, body: "", repo: "/tmp/gh", source: "manual", status, priority: 0, idempotencyKey, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", dependsOn: [], attempts: 1 });
const sentinel = (kind: string, enabled = true) => ({ id: `sen-${kind}`, boardId: "gh", kind, instructions: "", scope: "acme/gh", intervalMs: 300000, enabled, nextRunAt: "2025-01-01T00:05:00Z", lastRunAt: "2025-01-01T00:00:00Z" });
const overview = (jobs: ReturnType<typeof card>[], paused = false) => [
  { sentinel: sentinel("pr-health", !paused), name: "Broken pull requests", running: false, runs: [{ id: "r1", sentinelId: "sen-pr-health", status: "succeeded", startedAt: "2025-01-01T00:00:00Z", finishedAt: "2025-01-01T00:00:01Z", findings: [], summary: "1 new job card", error: null }],
    jobs: jobs.filter(job => job.idempotencyKey?.startsWith("sentinel:")).map(job => ({ ...job, sentinelId: "sen-pr-health" })) },
  { sentinel: sentinel("pr-requests"), name: "/bakery requests", running: false, runs: [], jobs: jobs.filter(job => job.idempotencyKey?.startsWith("request:")).map(job => ({ ...job, sentinelId: "sen-pr-requests" })) },
];
const cards = [
  card("k1", "Plain kanban card", "ready", null),
  card("s1", "Fix PR #5: Broken", "running", "sentinel:5:abc:def"),
  card("s2", "Requested on PR #6: Tweak", "review", "request:issues/comments:1"),
];

test("Sentinels lists timer and PR-comment jobs apart from the kanban", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards") return route.fulfill({ json: boards });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      if (path === "/api/boards/gh/cards") return route.fulfill({ json: cards });
      if (path === "/api/boards/gh/sentinels") return route.fulfill({ json: overview(cards.filter(item => item.idempotencyKey)) });
      await route.fulfill({ json: [] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const repo = page.getByRole("button", { name: "gh", exact: true });
    await repo.waitFor();
    if ((await repo.getAttribute("aria-expanded")) !== "true") await repo.click();
    await page.getByRole("button", { name: "Kanban", exact: true }).click();
    await page.getByText("Plain kanban card").waitFor();
    assert.equal(await page.getByText("Fix PR #5: Broken").count(), 0, "jobs stay off the kanban");
    await page.getByRole("button", { name: "Sentinels" }).click();
    const active = page.getByRole("list", { name: "Active sentinel jobs" });
    await active.getByText("Fix PR #5: Broken").waitFor();
    await active.getByText("Timer").waitFor();
    const recent = page.getByRole("list", { name: "Recent sentinel jobs" });
    await recent.getByText("PR comment").waitFor();
    assert.equal(await page.getByText("Plain kanban card").isVisible(), false);
    await page.getByRole("list", { name: "Broken pull requests runs" }).getByText("1 new job card").waitFor();
  } finally {
    await browser.close();
    await server.close();
  }
});

test("Sentinels hides done jobs until revealed and the sidebar badge follows in-progress jobs", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    let jobs = [
      card("s1", "Running job", "running", "sentinel:5:abc:def"),
      card("s2", "Done job", "done", "sentinel:6:abc:def"),
      card("s3", "Review job", "review", "request:issues/comments:1"),
    ];
    const inProgress = () => jobs.filter(job => ["running", "ready", "triage"].includes(job.status)).length;
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/boards") return route.fulfill({ json: boards.map(item => ({ ...item, sentinelsInProgress: inProgress() })) });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      if (path === "/api/boards/gh/cards") return route.fulfill({ json: jobs });
      if (path === "/api/boards/gh/sentinels") return route.fulfill({ json: overview(jobs) });
      await route.fulfill({ json: [] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const repo = page.getByRole("button", { name: "gh", exact: true });
    await repo.waitFor();
    if ((await repo.getAttribute("aria-expanded")) !== "true") await repo.click();
    const badge = page.locator("[data-sentinels-in-progress]");
    await badge.waitFor();
    assert.equal(await badge.textContent(), "1");
    await page.getByRole("button", { name: /^Sentinels/ }).click();
    await page.getByText("Running job").waitFor();
    await page.getByText("Review job").waitFor();
    assert.equal(await page.getByText("Done job").count(), 0, "done jobs are hidden by default");
    await page.getByLabel(/Show completed/).check();
    await page.getByText("Done job").waitFor();
    await page.getByLabel(/Show completed/).uncheck();
    assert.equal(await page.getByText("Done job").count(), 0);
    // A job enters in-progress: the badge goes up. Finishing jobs brings it down and hides it at zero.
    jobs = jobs.map(job => (job.id === "s3" ? { ...job, status: "running" } : job));
    await page.waitForFunction(() => document.querySelector("[data-sentinels-in-progress]")?.textContent === "2");
    jobs = jobs.map(job => (job.id === "s1" || job.id === "s3" ? { ...job, status: "done" } : job));
    await page.waitForFunction(() => !document.querySelector("[data-sentinels-in-progress]"), undefined, { timeout: 10000 });
  } finally {
    await browser.close();
    await server.close();
  }
});

test("Sentinels can be paused and resumed apart from their jobs", async () => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    let paused = false;
    const patches: unknown[] = [];
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === "/api/boards") return route.fulfill({ json: boards });
      if (path === "/api/settings") return route.fulfill({ json: { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" } });
      if (path === "/api/boards/gh/sentinels") return route.fulfill({ json: overview([card("s1", "Fix PR #5: Broken", "done", "sentinel:5:abc:def")], paused) });
      if (path === "/api/sentinels/sen-pr-health" && request.method() === "PATCH") { patches.push(request.postDataJSON()); paused = !request.postDataJSON().enabled; return route.fulfill({ json: sentinel("pr-health", !paused) }); }
      await route.fulfill({ json: [] });
    });
    await page.goto(server.resolvedUrls!.local[0]);
    const repo = page.getByRole("button", { name: "gh", exact: true });
    await repo.waitFor();
    if ((await repo.getAttribute("aria-expanded")) !== "true") await repo.click();
    await page.getByRole("button", { name: /^Sentinels/ }).click();
    const panel = page.getByRole("region", { name: "Broken pull requests" });
    await panel.getByText("Enabled", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Pause" }).click();
    await panel.getByText("Paused", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Resume" }).click();
    await panel.getByText("Enabled", { exact: true }).waitFor();
    assert.deepEqual(patches, [{ enabled: false }, { enabled: true }]);
  } finally {
    await browser.close();
    await server.close();
  }
});
