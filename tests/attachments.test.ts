import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { attachmentPath, removeCardAttachmentFiles, safeFileName, sweepOrphanAttachments } from "../server/attachments.js";
import { Board } from "../server/board.js";
import { Worker } from "../server/worker.js";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}
async function waitFor(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("file names lose directories and control characters", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("C:\\Users\\me\\shot.png"), "shot.png");
  assert.equal(safeFileName(".hidden"), "_hidden");
  assert.equal(safeFileName("a\nb.txt"), "a_b.txt");
  assert.equal(safeFileName(""), "file");
});

test("a multi-MB upload streams to disk, lists, downloads intact, and its path reaches the discussion prompt", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-attach-"));
  const repo = join(home, "repo"), data = join(home, "data"), fakePi = join(home, "pi-fake"), promptFile = join(home, "prompt.txt");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(fakePi, `#!/bin/sh\nprintf '%s' "$6" > '${promptFile}'\nprintf '%s\\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"seen"}]}}' '{"type":"agent_settled"}'\n`);
  chmodSync(fakePi, 0o755);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, BAKERY_HOST: "", BAKERY_ALLOWED_HOSTS: "", HOME: home, BAKERY_DATA_DIR: data, BAKERY_PORT: String(port), BAKERY_PI_BIN: fakePi },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${port}/api`;
    const json = async (path: string, method = "GET", input?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: input ? { "Content-Type": "application/json" } : undefined, body: input ? JSON.stringify(input) : undefined });
      return { status: response.status, data: await response.json() };
    };
    const deadline = Date.now() + 5000;
    while (true) {
      try { await fetch(`${url}/boards`); break; }
      catch {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Server did not start: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assert.equal((await json("/boards", "POST", { repo })).status, 201);
    const boardId = (await json("/boards")).data[0].id as string;
    const card = (await json(`/boards/${boardId}/cards`, "POST", { title: "Shots", body: "see the file" })).data;
    const base = `/boards/${boardId}/cards/${card.id}/attachments`;

    // 12 MB of random bytes sent as the raw body, with a hostile name.
    const bytes = randomBytes(12 * 1024 * 1024);
    const up = await fetch(`${url}${base}?name=${encodeURIComponent("../shot one.png")}`, { method: "POST", headers: { "Content-Type": "image/png" }, body: bytes });
    assert.equal(up.status, 201);
    const saved = await up.json() as { id: string; name: string; type: string; size: number; messageId: string | null };
    assert.deepEqual([saved.name, saved.type, saved.size, saved.messageId], ["shot one.png", "image/png", bytes.length, null]);
    const onDisk = attachmentPath(data, { cardId: card.id, id: saved.id, name: saved.name });
    assert.ok(onDisk.startsWith(join(data, "attachments", card.id)));
    assert.equal(statSync(onDisk).size, bytes.length);
    assert.ok(readFileSync(onDisk).equals(bytes));
    assert.ok(!existsSync(`${onDisk}.part`));

    assert.equal((await json(`/boards/${boardId}/cards`)).data[0].attachmentCount, 1);
    const listed = (await json(base)).data as { id: string }[];
    assert.deepEqual(listed.map(item => item.id), [saved.id]);
    const download = await fetch(`${url}${base}/${saved.id}`);
    assert.equal(download.headers.get("content-type"), "image/png");
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(bytes));

    // A non-image downloads as an opaque attachment, so an upload cannot run script here.
    const html = (await (await fetch(`${url}${base}?name=page.html`, { method: "POST", headers: { "Content-Type": "text/html" }, body: "<script>1</script>" })).json()) as { id: string };
    const page = await fetch(`${url}${base}/${html.id}`);
    assert.equal(page.headers.get("content-type"), "application/octet-stream");
    assert.match(page.headers.get("content-disposition") ?? "", /^attachment/);

    assert.equal((await fetch(`${url}${base}`, { method: "POST", body: "x" })).status, 400);
    assert.equal((await fetch(`${url}/boards/${boardId}/cards/missing/attachments`)).status, 404);

    // Sent with a discussion message, the file moves onto it and its path is in the prompt Pi receives.
    const sent = await json(`/boards/${boardId}/cards/${card.id}/discussion`, "POST", { message: "what is in it?", attachmentIds: [saved.id] });
    assert.equal(sent.status, 202);
    assert.deepEqual(sent.data.attachments.map((item: { id: string }) => item.id), [saved.id]);
    await waitFor(() => existsSync(promptFile));
    assert.ok(readFileSync(promptFile, "utf8").includes(onDisk));
    const thread = (await json(`/boards/${boardId}/cards/${card.id}/discussion`)).data;
    assert.equal(thread.messages[0].attachments[0].id, saved.id);
    // The same file cannot be sent twice, and unknown ids are refused.
    assert.equal((await json(`/boards/${boardId}/cards/${card.id}/discussion`, "POST", { message: "again", attachmentIds: [saved.id] })).status, 400);

    assert.equal((await json(`${base}/${html.id}`, "DELETE")).status, 200);
    assert.ok(!existsSync(join(data, "attachments", card.id, html.id)));
    assert.equal((await fetch(`${url}${base}/${html.id}`)).status, 404);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("close", resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

test("a work run's prompt lists the card's attachment paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-attach-"));
  const repo = join(dir, "repo"), data = join(dir, "data"), fakePi = join(dir, "pi-fake"), promptFile = join(dir, "prompt.txt");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    writeFileSync(fakePi, `#!/bin/sh\nprintf '%s' "$6" > '${promptFile}'\nprintf '%s\\n' '{"type":"agent_settled","aborted":false}'\n`);
    chmodSync(fakePi, 0o755);
    const board = new Board(join(dir, "board.sqlite")), worker = new Worker(board, data, fakePi);
    const card = board.createCard({ title: "Test", body: "", repo });
    const file = board.addAttachment({ id: "att-1", cardId: card.id, name: "error log.txt", type: "text/plain", size: 5 });
    board.setStatus(card.id, "ready");
    const run = worker.start(board.getCard(card.id)!);
    await waitFor(() => board.getRun(run.id)?.status === "review");
    const prompt = readFileSync(promptFile, "utf8");
    assert.ok(prompt.includes(attachmentPath(data, file)));
    assert.match(prompt, /error log\.txt, text\/plain, 5 bytes/);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the startup sweep removes attachment folders no row points to and keeps the rest", () => {
  const data = mkdtempSync(join(tmpdir(), "bakery-sweep-"));
  const put = (...parts: string[]) => { const file = join(data, "attachments", ...parts); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "x"); return file; };
  const kept = put("card1", "att1", "a.txt"), partial = put("card1", "att2", "b.txt.part"), gone = put("card2", "att3", "c.txt");
  assert.equal(sweepOrphanAttachments(data, [{ cardId: "card1", id: "att1" }]), 2);
  assert.ok(existsSync(kept));
  assert.ok(!existsSync(partial));
  assert.ok(!existsSync(gone));
  assert.ok(!existsSync(join(data, "attachments", "card2")));
  assert.equal(sweepOrphanAttachments(join(data, "none"), []), 0);
  rmSync(data, { recursive: true, force: true });
});

test("purging an archived card's attachments removes its rows and folder, and refuses other cards", () => {
  const dir = mkdtempSync(join(tmpdir(), "bakery-purge-"));
  const repo = join(dir, "repo"), data = join(dir, "data");
  try {
    const board = new Board(join(dir, "board.sqlite"));
    const put = (cardId: string, id: string) => {
      const file = board.addAttachment({ id, cardId, name: "a.txt", type: "text/plain", size: 5 });
      const path = attachmentPath(data, file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "hello");
      return path;
    };
    const archived = board.createCard({ title: "Old", body: "", repo }), other = board.createCard({ title: "Live", body: "", repo });
    const gone = [put(archived.id, "a1"), put(archived.id, "a2")], kept = put(other.id, "b1");
    board.setStatus(archived.id, "done");
    // A card that is not archived is refused, and nothing changes.
    assert.throws(() => board.purgeAttachments(repo, [archived.id]), /Only archived cards/);
    board.setArchived(repo, [archived.id], true);
    assert.throws(() => board.purgeAttachments(repo, [archived.id, other.id]), /Only archived cards/);
    assert.equal(board.listAttachments(archived.id).length, 2);
    assert.deepEqual(board.purgeAttachments(repo, [archived.id]), [{ cardId: archived.id, files: 2, bytes: 10 }]);
    removeCardAttachmentFiles(data, archived.id);
    assert.deepEqual(board.listAttachments(archived.id), []);
    assert.ok(gone.every(file => !existsSync(file)));
    assert.ok(!existsSync(join(data, "attachments", archived.id)));
    assert.ok(existsSync(kept));
    assert.equal(board.listAttachments(other.id).length, 1);
    board.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
