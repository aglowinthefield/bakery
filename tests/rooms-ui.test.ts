import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const fakePi = `#!/bin/sh
for last; do :; done
sys=""; prev=""
for a; do if [ "$prev" = "--append-system-prompt" ]; then sys="$a"; fi; prev="$a"; done
delta() { printf '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"%s"}}\\n' "$1"; }
case "$sys" in "You decide"*) delta '{\\"interject\\": false}';; *)
name=$(printf '%s' "$sys" | sed -n 's/^You are \\([A-Za-z]*\\).*/\\1/p' | head -1)
case "$last" in *SLOW*) delta "partial from $name "; sleep 20;; esac
delta "reply from $name";; esac
printf '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","usage":{"input":10,"output":5,"cost":{"total":0.01}}}}\\n{"type":"agent_settled","aborted":false}\\n'
`;

test("rooms UI: create colleagues and a room, send, ask everyone, queue and stop in a real browser", async () => {
  // The server serves the built UI (BAKERY_SERVE_UI=1); CI runs the tests before `npm run build`, so build when missing.
  if (!existsSync("dist/index.html")) execFileSync("npx", ["vite", "build"], { stdio: "ignore", shell: process.platform === "win32" });
  const home = mkdtempSync(join(tmpdir(), "bakery-rooms-ui-"));
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const pi = join(home, "pi");
  writeFileSync(pi, fakePi);
  chmodSync(pi, 0o755);
  const repo = join(home, "code", "alpha");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts"],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        BAKERY_HOST: "",
        BAKERY_ALLOWED_HOSTS: "",
        HOME: home,
        BAKERY_DATA_DIR: join(home, "data"),
        BAKERY_PORT: String(port),
        BAKERY_SENTINEL: "0",
        BAKERY_GH_BIN: "false",
        BAKERY_PI_BIN: pi,
        BAKERY_SERVE_UI: "1",
        IMPRESSION_URL: "http://127.0.0.1:1",
        IMPRESSION_TOKEN: "x",
      },
    },
  );
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 150; i++) {
      try {
        await fetch(`${url}/api/boards`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const post = (path: string, body: unknown) =>
      fetch(`${url}/api${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<any>);
    const board = await post("/boards", { repo });
    const page = await browser.newPage({
      viewport: { width: 1360, height: 900 },
    });
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
        problems.push(m.text());
    });
    await page.goto(`${url}/colleagues`);
    for (const name of ["Ada", "Bob"]) {
      await page.getByRole("button", { name: "New colleague" }).click();
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Specialty").fill(`${name} specialty`);
      await page
        .getByRole("form", { name: "Colleague form" })
        .getByLabel("alpha")
        .check();
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByTestId("colleague").filter({ hasText: name }).waitFor();
    }
    if (process.env.SHOT_DIR)
      await page.screenshot({
        path: join(process.env.SHOT_DIR, "colleagues.png"),
      });
    // Project-filtered shortcut under the repository.
    await page.goto(`${url}/rooms`);
    await page.getByRole("button", { name: "New room" }).click();
    await page.getByLabel("Title").fill("Planning");
    await page.getByLabel("Ada").check();
    await page.getByLabel("Bob").check();
    await page
      .getByRole("form", { name: "New room" })
      .getByLabel("alpha")
      .check();
    await page.getByRole("button", { name: "Create room" }).click();
    const box = page.getByLabel("Message");
    await box.fill("hello team");
    await page.getByRole("button", { name: "Send" }).click();
    await page
      .getByRole("listitem")
      .filter({ hasText: "reply from Ada" })
      .waitFor();
    assert.equal(
      await page.getByText("reply from Bob").count(),
      0,
      "only the lead answered",
    );
    await box.fill("@Bob your view?");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("reply from Bob").first().waitFor();
    await box.fill("everyone please");
    await page.getByRole("button", { name: "Ask everyone" }).click();
    await page.getByText("asked everyone").waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-live]").length === 0,
    );
    // Slow round, queue a message, then stop.
    await box.fill("SLOW work");
    await page.getByRole("button", { name: "Send" }).click();
    await page.locator("[data-live]").waitFor();
    await box.fill("later");
    await page.getByRole("button", { name: "Queue message" }).click();
    await page.getByLabel("Queue").getByText("later").waitFor();
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByText("queue paused").first().waitFor();
    await page.getByRole("button", { name: "Resume queue" }).click();
    await page.getByRole("listitem").filter({ hasText: "later" }).waitFor();
    if (process.env.SHOT_DIR)
      await page.screenshot({ path: join(process.env.SHOT_DIR, "room.png") });
    // Per-project shortcut filters the same list.
    await page.goto(`${url}/today`);
    await page
      .locator("#sidebar-repositories")
      .getByRole("button", { name: "alpha", exact: true })
      .click();
    await page
      .locator("#sidebar-repositories")
      .getByRole("button", { name: "Rooms" })
      .click();
    await page
      .getByRole("list", { name: "Rooms" })
      .getByText("Planning")
      .waitFor();
    assert.equal(
      await page.getByLabel("Filter rooms by project").inputValue(),
      board.id,
    );
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});
