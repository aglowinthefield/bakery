import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const card = (id: string, status: string, dependsOn: string[] = []) => ({ id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status,
  priority: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0, attempts: status === "done" ? 1 : 0, dependsOn, blocked: dependsOn.length > 0 });

async function drag(initial: ReturnType<typeof card>[]) {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let cards = initial;
  const requests: string[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (method === "POST") {
      const body = route.request().postDataJSON() ?? {};
      requests.push(`${path} ${JSON.stringify(body)}`);
      const match = path.match(/\/cards\/(\w+)\/status$/);
      const ids = new Set<string>();
      if (match) {
        // Mirrors the server: the card plus its Triage dependencies, transitively.
        const visit = (id: string) => { ids.add(id); for (const dep of cards.find(c => c.id === id)!.dependsOn) if (cards.find(c => c.id === dep)!.status === "triage" && !ids.has(dep)) visit(dep); };
        if (body.withDependencies) visit(match[1]); else ids.add(match[1]);
        cards = cards.map(item => ids.has(item.id) ? { ...item, status: body.status } : item);
      }
      await route.fulfill({ json: body.withDependencies ? cards.filter(c => ids.has(c.id)) : {} }); return;
    }
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": cards,
      "/api/boards/board/conflicts": [],
    };
    if (path === "/api/status") { await route.fulfill({ json: { draining: false, activeRuns: 0 } }); return; }
    assert.ok(path in data, `Unexpected API request: ${path}`);
    await route.fulfill({ json: data[path] });
  });
  await page.goto(new URL("/board/board", server.resolvedUrls!.local[0]).href);
  const lane = (status: string) => page.locator(`section[data-status="${status}"]`);
  const tile = (name: string) => page.getByRole("button", { name: new RegExp(`^.*${name} card`) });
  await tile("top").waitFor();
  return { page, requests, lane, tile, close: async () => { await browser.close(); await server.close(); } };
}

test("dragging a Triage card to Ready brings the Triage cards it waits on, nested ones included", async () => {
  const ui = await drag([card("top", "triage", ["mid", "gone"]), card("mid", "triage", ["leaf"]), card("leaf", "triage"), card("unrelated", "triage"), card("gone", "done")]);
  try {
    const { page, lane, tile } = ui;
    // Hold the drag over Ready so the highlight can be inspected before the drop.
    const source = await tile("top").boundingBox(), target = await lane("ready").boundingBox();
    await page.mouse.move(source!.x + 20, source!.y + 20);
    await page.mouse.down();
    await page.mouse.move(target!.x + 40, target!.y + 60, { steps: 10 });
    await page.mouse.move(target!.x + 50, target!.y + 70, { steps: 5 });
    await lane("ready").getByText("+2 cards it waits on").waitFor();
    assert.equal(await tile("mid").getAttribute("data-comes-along"), "true");
    assert.equal(await tile("leaf").getAttribute("data-comes-along"), "true");
    assert.equal(await tile("unrelated").getAttribute("data-comes-along"), null);
    assert.equal(await tile("top").getAttribute("data-comes-along"), null);
    await page.mouse.up();
    for (const id of ["top", "mid", "leaf"]) await lane("ready").getByRole("button", { name: new RegExp(`${id} card`) }).waitFor();
    await page.getByRole("status", { name: "Move notice" }).getByText("Moved 3 cards to Ready: top card and the 2 cards it waits on").waitFor();
    assert.equal(await lane("triage").getByRole("button", { name: /unrelated card/ }).count(), 1);
    assert.equal(await lane("done").getByRole("button", { name: /gone card/ }).count(), 1);
    assert.deepEqual(ui.requests, ['/api/boards/board/cards/top/status {"status":"ready","withDependencies":true}']);
  } finally { await ui.close(); }
});

test("a dependency that is already Done stays put and nothing extra moves", async () => {
  const ui = await drag([card("top", "triage", ["old"]), card("old", "done")]);
  try {
    const { page, lane, tile } = ui;
    await tile("top").dragTo(lane("ready"));
    await lane("ready").getByRole("button", { name: /top card/ }).waitFor();
    assert.equal(await page.getByRole("status", { name: "Move notice" }).count(), 0);
    assert.equal(await lane("done").getByRole("button", { name: /old card/ }).count(), 1);
    assert.deepEqual(ui.requests, ['/api/boards/board/cards/top/status {"status":"ready"}']);
  } finally { await ui.close(); }
});
