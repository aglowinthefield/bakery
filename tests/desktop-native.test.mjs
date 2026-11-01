// Run on an isolated Linux X11 display, not on your working desktop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function eventually(check, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const xdo = (...args) =>
  execFileSync("xdotool", args, { encoding: "utf8" }).trim();
function windowId(name) {
  try {
    return xdo("search", "--onlyvisible", "--name", `^${name}$`).split("\n")[0];
  } catch {
    return null;
  }
}

function submit(connection, address) {
  xdo("windowraise", connection, "windowfocus", "--sync", connection);
  // The launcher is fixed at its default 620px width; account for the GTK menu bar.
  xdo(
    "mousemove",
    "--window",
    connection,
    "180",
    "298",
    "click",
    "1",
    "key",
    "ctrl+a",
  );
  xdo("type", "--clearmodifiers", address);
  xdo("key", "Return");
}

test(
  "native client isolates remote commands, reconnects, and delegates links and downloads",
  { timeout: 60000 },
  async () => {
    assert.equal(
      process.platform,
      "linux",
      "This smoke test requires Linux and X11.",
    );
    assert.ok(
      process.env.DISPLAY,
      "Run with an isolated X11 display, for example xvfb-run.",
    );
    const directory = await mkdtemp(join(tmpdir(), "bakery-native-"));
    const openLog = join(directory, "opened");
    await mkdir(join(directory, "bin"));
    await writeFile(
      join(directory, "bin", "xdg-open"),
      '#!/bin/sh\nprintf "%s\\n" "$1" >> "$BAKERY_OPEN_LOG"\n',
      { mode: 0o755 },
    );
    const reports = [];
    const requests = [];
    const server = createServer(async (request, response) => {
      requests.push(request.url);
      if (request.url === "/api/status") {
        response.setHeader("Content-Type", "application/json");
        response.end('{"draining":false,"activeRuns":0}');
      } else if (request.url === "/report") {
        let body = "";
        for await (const chunk of request) body += chunk;
        reports.push(JSON.parse(body));
        response.end("ok");
      } else if (request.url === "/attachment") {
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader(
          "Content-Disposition",
          'attachment; filename="example.txt"',
        );
        response.end("Bakery attachment");
      } else {
        response.setHeader("Content-Type", "text/html");
        response.end(`<!doctype html><title>Bakery fixture</title>
        <style>a { display:block; height:48px; }</style>
        <a href="https://example.org/bakery-desktop-test" target="_blank">External link</a>
        <a href="/attachment" download="example.txt">Download attachment</a>
        <script>
        (async () => {
          const denied = [];
          for (const [command, args] of [
            ["saved_server", {}],
            ["connect", { address: location.origin, allowHttp: true }],
            ["plugin:opener|open_url", { url: "https://example.org/forbidden" }]
          ]) {
            try { await window.__TAURI__.core.invoke(command, args); denied.push(false); }
            catch (error) { denied.push(String(error)); }
          }
          const status = await fetch("/api/status").then(r => r.json());
          history.pushState({}, "", "/board/test");
          await fetch("/report", { method: "POST", body: JSON.stringify({denied, status, path: location.pathname}) });
        })();
        </script>`);
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${server.address().port}/`;
    let logs = "";
    const app = spawn(
      process.env.BAKERY_DESKTOP_BINARY ||
        resolve("src-tauri/target/debug/bakery-desktop"),
      [],
      {
        env: {
          ...process.env,
          PATH: `${join(directory, "bin")}:${process.env.PATH}`,
          BAKERY_OPEN_LOG: openLog,
          XDG_CONFIG_HOME: join(directory, "config"),
          XDG_DATA_HOME: join(directory, "data"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stopped = new Promise((resolve) => app.once("close", resolve));
    app.on("error", (error) => {
      logs += error.message;
    });
    app.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    app.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    try {
      const connection = await eventually(
        () => windowId("Connect to Bakery"),
        "connection window",
      );
      await delay(750);
      for (let count = 1; count <= 5; count++) {
        submit(
          connection,
          count === 2 ? address.replace("127.0.0.1", "localhost") : address,
        );
        await eventually(() => reports.length === count, `connection ${count}`);
        const report = reports[count - 1];
        assert.equal(report.denied.length, 3);
        for (const denial of report.denied)
          assert.match(denial, /not allowed|not permitted|denied/i);
        assert.equal(report.status.activeRuns, 0);
        assert.equal(report.path, "/board/test");
      }
      assert.equal(
        await readFile(
          join(directory, "config/dev.bakery.desktop/server-url"),
          "utf8",
        ),
        address,
      );
      const remote = await eventually(
        () => windowId("Bakery"),
        "remote fixture window",
      );
      xdo("windowraise", remote, "windowfocus", "--sync", remote);
      xdo("mousemove", "--window", remote, "80", "45", "click", "1");
      await eventually(
        async () =>
          (await readFile(openLog, "utf8").catch(() => "")).includes(
            "https://example.org/bakery-desktop-test",
          ),
        "external browser link",
      );
      xdo("mousemove", "--window", remote, "80", "93", "click", "1");
      await eventually(
        async () =>
          (await readFile(openLog, "utf8")).includes(`${address}attachment`),
        "attachment handed to browser",
      );
      assert.ok(
        !(await readFile(openLog, "utf8")).includes("forbidden"),
        "remote opener command escaped its capability boundary",
      );
      xdo("windowquit", connection);
      await eventually(
        () => !windowId("Connect to Bakery"),
        "settings to hide",
      );
      xdo("windowquit", remote);
      await eventually(
        () => !windowId("Bakery") && windowId("Connect to Bakery"),
        "settings to recover after closing Bakery",
      );
      submit(connection, address);
      await eventually(() => reports.length === 6, "reopening Bakery");
      assert.equal(
        windowId("Bakery"),
        remote,
        "reconnect must reuse the native webview",
      );
      xdo("windowquit", remote);
      await eventually(
        () => !windowId("Bakery") && windowId("Connect to Bakery"),
        "settings to recover again",
      );
      xdo("windowquit", connection);
      await eventually(
        () => app.exitCode === 0,
        "app to exit without hidden windows",
      );
    } catch (error) {
      throw new Error(
        `${error.message}\nRequests: ${requests.join(", ")}\nNative app log:\n${logs}`,
        { cause: error },
      );
    } finally {
      app.kill();
      await stopped;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
