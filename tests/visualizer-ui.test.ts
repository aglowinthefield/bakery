import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let url: string;
before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

const card = (id: string, status: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({
  id, title: `${id} card`, body: "", repo: "/tmp/repo", source: "manual", status, priority: 0,
  createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 2, turnsIncomplete: 0, attempts: 0, reviewRounds: 0,
  runAgent: "", reviewAgent: "", dependsOn, blocked: false, ...extra,
});

async function open(cards: unknown[], theme = "default") {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const data: Record<string, unknown> = {
    "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
    "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme },
    "/api/boards/board/cards": cards,
    "/api/boards/board/conflicts": [],
    "/api/status": { draining: false, activeRuns: 0 },
  };
  await page.route("**/api/**", route => route.fulfill({ json: data[new URL(route.request().url()).pathname] ?? [] }));
  await page.goto(new URL("/board/board/visualizer", url).href);
  return Object.assign(page, { data });
}

const labelBox = async (page: Page, id: string) => {
  const box = await page.locator(`[data-viz-label="${id}"]`).boundingBox();
  assert.ok(box, `label ${id}`);
  return box;
};

/** The RGB of the canvas at a point, read from a screenshot because the WebGL buffer is not kept between frames. */
const pixel = async (page: Page, x: number, y: number) => {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(async ({ png, x, y }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(x, y, 1, 1).data.slice(0, 3)];
  }, { png, x, y });
};

const cards = [
  card("root", "done"),
  card("mid", "running", ["root"]),
  card("leaf", "ready", ["mid"], { blocked: true }),
  card("alone", "triage"),
];

test("the graph lays out left to right, and drag, wheel and fit move the view", async () => {
  const page = await open(cards);
  try {
    await page.locator("[data-viz-label]").first().waitFor({ state: "attached" });
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("[data-viz-label]")].filter(el => el.style.display !== "none").length === 4);
    const [root, mid, leaf] = [await labelBox(page, "root"), await labelBox(page, "mid"), await labelBox(page, "leaf")];
    assert.ok(root.x < mid.x && mid.x < leaf.x, "each dependent sits to the right of its dependency");
    assert.match((await page.locator('[data-viz-label="leaf"]').textContent())!, /leaf card.*blocked by 1/);
    assert.match((await page.locator('[data-viz-label="mid"]').textContent())!, /running · turn 2/);

    const canvas = page.locator("[data-visualizer-canvas]");
    const box = (await canvas.boundingBox())!;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const fitted = await labelBox(page, "mid");

    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 120, center.y + 40, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(({ x }) => Math.abs(document.querySelector<HTMLElement>('[data-viz-label="mid"]')!.getBoundingClientRect().x - x) > 100, { x: fitted.x });
    const panned = await labelBox(page, "mid");
    assert.ok(Math.abs(panned.x - fitted.x - 120) < 2 && Math.abs(panned.y - fitted.y - 40) < 2, "dragging moves the graph with the pointer");

    // Zooming at the cursor keeps the point under it fixed: aim at the circle of "mid", just above its label.
    const aim = { x: panned.x + panned.width / 2, y: panned.y - 22 * 0.9 };
    await page.mouse.move(aim.x, aim.y);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(({ x }) => Math.abs(document.querySelector<HTMLElement>('[data-viz-label="leaf"]')!.getBoundingClientRect().x - document.querySelector<HTMLElement>('[data-viz-label="mid"]')!.getBoundingClientRect().x) > x, { x: 270 * 0.9 * 1.2 });
    const zoomed = await labelBox(page, "mid");
    const gap = (await labelBox(page, "leaf")).x - zoomed.x;
    assert.ok(gap > 270 * 0.9 * 1.2, `the labels spread apart when zooming in (${gap})`);
    assert.ok(Math.abs(zoomed.x + zoomed.width / 2 - (aim.x)) < 1.5, "the point under the cursor stays put");

    await page.keyboard.press("f");
    await page.waitForFunction(({ x }) => Math.abs(document.querySelector<HTMLElement>('[data-viz-label="mid"]')!.getBoundingClientRect().x - x) < 1, { x: fitted.x });
    await page.mouse.wheel(0, 400);
    await page.mouse.dblclick(center.x, center.y);
    await page.waitForFunction(({ x }) => Math.abs(document.querySelector<HTMLElement>('[data-viz-label="mid"]')!.getBoundingClientRect().x - x) < 1, { x: fitted.x });
  } finally { await page.close(); }
});

test("colors follow the active theme and are re-read when data-theme changes", async () => {
  const page = await open(cards, "default");
  try {
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("[data-viz-label]")].some(el => el.style.display !== "none"));
    await page.waitForFunction(() => document.documentElement.dataset.theme === "default");
    const dark = await pixel(page, 20, 400);
    const label = page.locator('[data-viz-label="mid"] div').last();
    const darkColor = await label.evaluate(el => getComputedStyle(el).color);
    assert.ok(dark[0] < 80 && dark[1] < 80 && dark[2] < 80, `dark theme background ${dark}`);

    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await page.waitForFunction(({ was }) => getComputedStyle(document.querySelector('[data-viz-label="mid"] div:last-child')!).color !== was, { was: darkColor });
    await page.waitForTimeout(150);
    const light = await pixel(page, 20, 400);
    assert.ok(light[0] > 200 && light[1] > 200 && light[2] > 200, `light theme background ${light}`);
  } finally { await page.close(); }
});

test("a card leaving the board drops its label, and closing the view removes the canvas", async () => {
  const page = await open(cards);
  try {
    await page.locator('[data-viz-label="alone"]').waitFor({ state: "attached" });
    assert.equal(await page.locator("[data-viz-label]").count(), 4);
    assert.equal(await page.locator("[data-visualizer-canvas] canvas").count(), 1);
    page.data["/api/boards/board/cards"] = cards.filter(c => c.id !== "alone");
    await page.waitForFunction(() => document.querySelectorAll("[data-viz-label]").length === 3);
    assert.equal(await page.locator('[data-viz-label="alone"]').count(), 0);
    await page.getByText("Kanban", { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("[data-visualizer-canvas]"));
    assert.equal(await page.locator("[data-viz-label]").count(), 0);
  } finally { await page.close(); }
});
