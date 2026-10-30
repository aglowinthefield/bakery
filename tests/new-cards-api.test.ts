import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

test("cards made outside the board UI count as new until the board is opened", async () => {
  const home = mkdtempSync(join(tmpdir(), "bakery-new-cards-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BAKERY_HOST: "",
        BAKERY_ALLOWED_HOSTS: "",
        HOME: home,
        BAKERY_DATA_DIR: join(home, "data"),
        BAKERY_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  try {
    const url = `http://127.0.0.1:${port}/api`;
    const request = async (path: string, method = "GET", input?: unknown) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: input ? { "Content-Type": "application/json" } : undefined,
        body: input ? JSON.stringify(input) : undefined,
      });
      return { status: response.status, data: await response.json() };
    };
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await fetch(`${url}/boards`);
        break;
      } catch {
        if (Date.now() > deadline || child.exitCode !== null)
          throw new Error(`Server did not start: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const boardId = (await request("/boards", "POST", { repo })).data
      .id as string;
    const newCards = async () =>
      (
        (await request("/boards")).data as { id: string; newCards: number }[]
      ).find((item) => item.id === boardId)!.newCards;
    assert.equal(await newCards(), 0);

    // A card created through the API (as the CLI, chat and agents do) is new; one the UI sends with origin "ui" is not.
    const outside = (
      await request(`/boards/${boardId}/cards`, "POST", {
        title: "From the CLI",
        body: "",
      })
    ).data.id as string;
    const uiCard = (
      await request(`/boards/${boardId}/cards`, "POST", {
        title: "From the UI",
        body: "",
        origin: "ui",
      })
    ).data.id as string;
    assert.equal(await newCards(), 1);

    // Opening the board returns just the unseen card and clears the count; a repeat visit finds nothing.
    assert.deepEqual(
      (
        await request(`/boards/${boardId}/cards-seen`, "POST", {
          cardIds: [outside, uiCard],
        })
      ).data,
      { cardIds: [outside] },
    );
    assert.equal(await newCards(), 0);
    assert.deepEqual(
      (
        await request(`/boards/${boardId}/cards-seen`, "POST", {
          cardIds: [outside],
        })
      ).data,
      { cardIds: [] },
    );

    // A later outside card counts again.
    const later = (
      await request(`/boards/${boardId}/cards`, "POST", {
        title: "Agent follow-up",
        body: "",
      })
    ).data.id as string;
    assert.equal(await newCards(), 1);
    assert.deepEqual(
      (
        await request(`/boards/${boardId}/cards-seen`, "POST", {
          cardIds: [later],
        })
      ).data,
      { cardIds: [later] },
    );
    assert.equal(
      (await request("/boards/missing/cards-seen", "POST", { cardIds: [] }))
        .status,
      404,
    );
    assert.equal(
      (
        await request(`/boards/${boardId}/cards-seen`, "POST", {
          cardIds: "all",
        })
      ).status,
      400,
    );
  } finally {
    child.kill();
  }
});
