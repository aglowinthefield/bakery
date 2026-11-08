import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../server/board.js";
import { Worker } from "../server/worker.js";
import { evidencePrompt, quoteArg } from "../server/attachments.js";

// A 1x1 PNG.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

function cli(port: number, cwd: string, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(process.cwd(), "scripts", "bakery-cli.mjs"), ...args], { cwd, env: { ...process.env, BAKERY_URL: `http://127.0.0.1:${port}` } });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("close", code => resolve({ code, out, err }));
  });
}

test("bakery-cli attach saves local files on the card; they survive deleting the originals and a server restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-evidence-"));
  const repo = join(home, "repo"), data = join(home, "data"), capture = join(home, "capture");
  mkdirSync(repo); mkdirSync(capture);
  execFileSync("git", ["init", "-q", repo]);
  const port = await freePort();
  let server: ChildProcess | undefined;
  const start = async () => {
    server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: data, BAKERY_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await fetch(`http://127.0.0.1:${port}/api/boards`); return; }
      catch {
        if (Date.now() > deadline || server.exitCode !== null) throw new Error("Server did not start");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  };
  const stop = async () => { const child = server!; child.kill("SIGTERM"); await new Promise(resolve => child.once("close", resolve)); };
  try {
    await start();
    const origin = `http://127.0.0.1:${port}`, api = `${origin}/api`;
    const added = await fetch(`${api}/boards`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo }) });
    assert.equal(added.status, 201);
    const boardId = ((await (await fetch(`${api}/boards`)).json()) as { id: string }[])[0].id;
    const card = await (await fetch(`${api}/boards/${boardId}/cards`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Shots", body: "" }) })).json() as { id: string };

    writeFileSync(join(capture, "before.png"), png);
    writeFileSync(join(capture, "run.log"), "log line\n");
    const attached = await cli(port, repo, "attach", card.id, join(capture, "before.png"), join(capture, "run.log"), "--board", boardId);
    assert.equal(attached.code, 0, attached.err);
    const lines = attached.out.trim().split("\n");
    const base = `/api/boards/${boardId}/cards/${card.id}/attachments`;
    assert.match(lines[0], new RegExp(`^!\\[before\\.png\\]\\(${base}/[\\w-]+\\)$`));
    assert.match(lines[1], new RegExp(`^\\[run\\.log\\]\\(${base}/[\\w-]+\\)$`));
    const url = (line: string) => `http://127.0.0.1:${port}${line.match(/\(([^)]+)\)/)![1]}`;

    // The card now lists both, and the image is served as an image.
    assert.equal(((await (await fetch(`${api}/boards/${boardId}/cards`)).json()) as { attachmentCount: number }[])[0].attachmentCount, 2);
    const shot = await fetch(url(lines[0]));
    assert.equal(shot.headers.get("content-type"), "image/png");
    assert.ok(Buffer.from(await shot.arrayBuffer()).equals(png));
    assert.equal((await fetch(url(lines[1]))).headers.get("content-type"), "application/octet-stream");

    // Evidence no longer depends on the original files or this server process.
    rmSync(capture, { recursive: true });
    await stop();
    await start();
    const again = await fetch(url(lines[0]));
    assert.equal(again.status, 200);
    assert.ok(Buffer.from(await again.arrayBuffer()).equals(png));

    // A missing file, a directory and an unknown card each fail by name, and attach nothing.
    const missing = await cli(port, repo, "attach", card.id, join(capture, "gone.png"), "--board", boardId);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /Cannot attach .*gone\.png: no such file/);
    const directory = await cli(port, repo, "attach", card.id, home, "--board", boardId);
    assert.match(directory.err, /not a regular file/);
    const noCard = await cli(port, repo, "attach", "no-such-card", join(home, "repo"), "--board", boardId);
    assert.match(noCard.err, /Card not found/);
    assert.equal(((await (await fetch(`${api}/boards/${boardId}/cards`)).json()) as { attachmentCount: number }[])[0].attachmentCount, 2);

    // The server has no route that reads a path: a path in the query or body is not a file read.
    const sneaky = await fetch(`${origin}${base}?name=passwd&path=/etc/passwd`, { method: "POST", headers: { "Content-Type": "image/png" }, body: "x" });
    assert.equal(sneaky.status, 201);
    const stored = await sneaky.json() as { id: string; size: number };
    assert.equal(stored.size, 1);
    assert.equal(await (await fetch(`${origin}${base}/${stored.id}`)).text(), "x");
  } finally {
    if (server && server.exitCode === null) await stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a work run's prompt tells the agent to attach evidence with the CLI, and omits it when the server address is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-evidence-"));
  const repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "pi-fake");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    const board = new Board(join(dir, "board.sqlite"));
    const repoBoard = board.addRepo(repo);
    const prompts: string[] = [];
    for (const attach of [{ cli: "/opt/bakery/bakery-cli.mjs", env: { BAKERY_URL: "http://127.0.0.1:4317", BAKERY_ALLOW_REMOTE: "1" } }, undefined]) {
      const promptFile = join(dir, `prompt-${prompts.length}.txt`);
      writeFileSync(fakePi, `#!/bin/sh\nprintf '%s' "$6" > '${promptFile}'\nprintf '%s %s' "$BAKERY_URL" "$BAKERY_ALLOW_REMOTE" > '${promptFile}.env'\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
      chmodSync(fakePi, 0o755);
      const card = board.createCard({ title: "Test", body: "", repo });
      board.setStatus(card.id, "ready");
      const run = new Worker(board, data, fakePi, undefined, attach).start(board.getCard(card.id)!);
      const deadline = Date.now() + 10_000;
      while (board.getRun(run.id)?.status !== "review") {
        if (Date.now() > deadline) throw new Error("Run did not finish");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(existsSync(promptFile));
      prompts.push(readFileSync(promptFile, "utf8"));
      // The address reaches the agent through its environment, not a shell prefix in the command.
      if (attach) assert.equal(readFileSync(`${promptFile}.env`, "utf8"), "http://127.0.0.1:4317 1");
      if (attach) assert.ok(prompts[0].includes(`node '/opt/bakery/bakery-cli.mjs' attach ${card.id} --board ${repoBoard.id} FILE...`));
    }
    assert.match(prompts[0], /saved as attachments of this card before you finish/);
    assert.match(prompts[0], /Do not upload files anywhere else/);
    assert.doesNotMatch(prompts[1], /attach/i);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the attach command quotes an installation path with spaces for POSIX shells and for cmd and PowerShell", () => {
  assert.equal(quoteArg("/opt/my tools/bakery-cli.mjs", "linux"), "'/opt/my tools/bakery-cli.mjs'");
  assert.equal(quoteArg("/opt/it's here/cli.mjs", "darwin"), `'/opt/it'\\''s here/cli.mjs'`);
  assert.equal(quoteArg("C:\\Program Files\\Bakery\\scripts\\bakery-cli.mjs", "win32"), '"C:\\Program Files\\Bakery\\scripts\\bakery-cli.mjs"');
  const posix = evidencePrompt({ cli: "/opt/my tools/bakery-cli.mjs" }, "b1", "c1", "linux");
  assert.ok(posix.includes("`node '/opt/my tools/bakery-cli.mjs' attach c1 --board b1 FILE...`"));
  const windows = evidencePrompt({ cli: "C:\\Program Files\\Bakery\\bakery-cli.mjs" }, "b1", "c1", "win32");
  assert.ok(windows.includes('`node "C:\\Program Files\\Bakery\\bakery-cli.mjs" attach c1 --board b1 FILE...`'));
  assert.doesNotMatch(windows, /BAKERY_URL|BAKERY_ALLOW_REMOTE/, "no POSIX environment prefix, which cmd.exe and PowerShell cannot run");
});

test("bakery-cli attach prints each saved file at once and keeps it when a later file fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-evidence-"));
  const repo = join(home, "repo"), data = join(home, "data");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const port = await freePort();
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: process.cwd(), env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: data, BAKERY_PORT: String(port) }, stdio: "ignore" });
  try {
    const api = `http://127.0.0.1:${port}/api`;
    for (let i = 0; i < 400; i++) { try { if ((await fetch(`${api}/boards`)).ok) break; } catch { /* Not up yet. */ } await new Promise(resolve => setTimeout(resolve, 25)); }
    await fetch(`${api}/boards`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo }) });
    const boardId = ((await (await fetch(`${api}/boards`)).json()) as { id: string }[])[0].id;
    const card = (await (await fetch(`${api}/boards/${boardId}/cards`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Shots", body: "" }) })).json()) as { id: string };
    writeFileSync(join(home, "ok.png"), png);
    const text = await cli(port, repo, "attach", card.id, join(home, "ok.png"), join(home, "gone.png"), "--board", boardId);
    assert.notEqual(text.code, 0);
    assert.match(text.out.trim(), new RegExp(`^!\\[ok\\.png\\]\\(/api/boards/${boardId}/cards/${card.id}/attachments/[\\w-]+\\)$`));
    assert.match(text.err, /Cannot attach .*gone\.png: no such file/);
    const json = await cli(port, repo, "attach", card.id, join(home, "ok.png"), join(home, "gone.png"), "--board", boardId, "--json");
    assert.notEqual(json.code, 0);
    const saved = JSON.parse(json.out) as { name: string }[];
    assert.deepEqual(saved.map(item => item.name), ["ok.png"]);
    assert.match(json.err, /gone\.png/);
  } finally { server.kill(); rmSync(home, { recursive: true, force: true }); }
});
