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

const ready = (page: Page, count: number) =>
  page.waitForFunction((n) => [...document.querySelectorAll<HTMLElement>("[data-viz-label]")].filter(el => el.style.display !== "none").length === n, count);

/** Mean brightness of the graph area, from a screenshot. */
const brightness = async (page: Page) => {
  const box = (await page.locator("[data-visualizer-canvas]").boundingBox())!;
  const png = (await page.screenshot({ clip: box })).toString("base64");
  return page.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    return sum / (data.length / 4) / 3;
  }, png);
};

test("a running card shows its live tool, turn and elapsed time, and the time ticks", async () => {
  const since = new Date(Date.now() - 12_000).toISOString();
  const page = await open([card("root", "done"), card("mid", "running", ["root"], { live: { tool: "bash", turn: 7, since } })]);
  try {
    const label = page.locator('[data-viz-label="mid"]');
    await page.waitForFunction(() => /bash · turn 7 · 1\ds/.test(document.querySelector('[data-viz-label="mid"]')?.textContent ?? ""));
    const first = await label.textContent();
    await page.waitForFunction((was) => document.querySelector('[data-viz-label="mid"]')!.textContent !== was, first, { timeout: 3000 });
    assert.match((await label.textContent())!, /bash · turn 7 · 1\ds/);
  } finally { await page.close(); }
});

test("the glow setting changes bloom and is remembered", async () => {
  const page = await open(cards);
  try {
    await ready(page, 4);
    const glow = page.getByRole("group", { name: "Glow" });
    assert.equal(await glow.getByRole("button", { name: "Normal" }).getAttribute("aria-pressed"), "true");
    await glow.getByRole("button", { name: "Full" }).click();
    await page.waitForTimeout(300);
    const full = await brightness(page);
    await glow.getByRole("button", { name: "Off" }).click();
    await page.waitForTimeout(300);
    const off = await brightness(page);
    assert.ok(full > off + 1, `Full is brighter than Off (${full} vs ${off})`);
    assert.equal(await page.evaluate(() => localStorage.getItem("bakery-visualizer-glow")), "off");
    await page.reload();
    await ready(page, 4);
    assert.equal(await page.getByRole("group", { name: "Glow" }).getByRole("button", { name: "Off" }).getAttribute("aria-pressed"), "true");
  } finally { await page.close(); }
});

// In-page helpers are strings: tsx would wrap functions defined inside them in a `__name` call the page lacks.

/** Counts animation frames the page asks for, so a test can see whether the render loop runs. */
const countFrames = (page: Page) => page.addInitScript(`
  window.__frames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (callback) { window.__frames++; return raf(callback); };
`);
const framesIn = async (page: Page, ms: number) => {
  const before = await page.evaluate<number>("window.__frames");
  await page.waitForTimeout(ms);
  return (await page.evaluate<number>("window.__frames")) - before;
};
/**
 * Waits for the page to ask for more than five frames. A wait rather than a count in a fixed
 * window, because software WebGL on a loaded machine can manage only a few frames a second.
 */
const framesKeepComing = async (page: Page) => {
  const before = await page.evaluate<number>("window.__frames");
  await page.waitForFunction(`window.__frames > ${before + 5}`, undefined, { timeout: 10_000 });
};
const setHidden = (page: Page, hidden: boolean) => page.evaluate(`
  Object.defineProperty(document, "hidden", { configurable: true, get: function () { return ${hidden}; } });
  document.dispatchEvent(new Event("visibilitychange"));
`);

test("the render loop runs with motion, stops while the tab is hidden, and idles with reduced motion", async () => {
  const viz = await open(cards);
  try {
    await countFrames(viz);
    await viz.reload();
    await ready(viz, 4);
    await framesKeepComing(viz);
    await setHidden(viz, true);
    await viz.waitForTimeout(100);
    assert.equal(await framesIn(viz, 400), 0, "no frames while hidden");
    await setHidden(viz, false);
    await framesKeepComing(viz);
    await viz.emulateMedia({ reducedMotion: "reduce" });
    // A frame already in flight may still land, so wait for the requests to stop rather than sleeping.
    await viz.waitForFunction(`new Promise(function (resolve) {
      const seen = window.__frames;
      setTimeout(function () { resolve(window.__frames === seen); }, 400);
    })`, undefined, { timeout: 10_000, polling: 100 });
    assert.equal(await framesIn(viz, 400), 0, "reduced motion renders only on change");
  } finally { await viz.close(); }
});

/**
 * Records a label's x position every 16 ms until it has moved and then held its rounded
 * position for 1.5 s, or for at most 20 s. Waiting for it to settle, rather than sampling a
 * fixed window, keeps the slide whole when frames are slow (the slide advances at most
 * 0.1 s of easing per frame, so at a few frames a second it takes several seconds).
 */
const track = (page: Page, id: string) => page.evaluate<number[]>(`new Promise(function (resolve) {
  const xs = [];
  const start = performance.now();
  let still = start;
  (function step() {
    const now = performance.now();
    const x = document.querySelector('[data-viz-label="${id}"]').getBoundingClientRect().x;
    if (xs.length && Math.round(x) !== Math.round(xs[xs.length - 1])) still = now;
    xs.push(x);
    const settled = Math.round(x) !== Math.round(xs[0]) && now - still > 1500;
    if (settled || now - start > 20000) resolve(xs); else setTimeout(step, 16);
  })();
})`);

for (const reduced of [false, true])
  test(reduced ? "with reduced motion a moved node jumps to its new place" : "a moved node slides to its new place", async () => {
    const page = await open(cards);
    try {
      if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
      await ready(page, 4);
      await page.waitForTimeout(300);
      page.data["/api/boards/board/cards"] = cards.map(c => c.id === "alone" ? { ...c, dependsOn: ["mid"] } : c);
      const xs = await track(page, "alone");
      const steps = new Set(xs.map(x => Math.round(x))).size;
      assert.ok(xs[xs.length - 1] !== xs[0], "the node moved");
      if (reduced) assert.ok(steps <= 3, `it jumps (${steps} positions)`);
      else assert.ok(steps > 6, `it slides through in-between positions (${steps})`);
    } finally { await page.close(); }
  });

const opacityOf = (page: Page, id: string) =>
  page.locator(`[data-viz-label="${id}"]`).evaluate((el) => Number(getComputedStyle(el).opacity));

/** The screen point of a node's circle, just above its label. */
const circle = async (page: Page, id: string) => {
  const box = await labelBox(page, id);
  return { x: box.x + box.width / 2, y: box.y - 22 * 0.9 };
};

const chainCards = [
  card("root", "done"),
  card("mid", "running", ["root"]),
  card("leaf", "ready", ["mid"]),
  card("side", "triage", ["root"]),
  card("alone", "triage"),
];

test("hovering a card keeps its whole dependency chain and dims the rest", async () => {
  const page = await open(chainCards);
  try {
    await ready(page, 5);
    await page.waitForTimeout(300);
    const at = await circle(page, "mid");
    await page.mouse.move(at.x, at.y);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[data-viz-label="alone"]')!).opacity) < 0.3);
    for (const id of ["root", "mid", "leaf"]) assert.equal(await opacityOf(page, id), 1, `${id} stays lit`);
    for (const id of ["side", "alone"]) assert.ok((await opacityOf(page, id)) < 0.3, `${id} dims`);
    await page.mouse.move(at.x, at.y + 150);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[data-viz-label="alone"]')!).opacity) === 1);
  } finally { await page.close(); }
});

test("clicking a card opens its details without leaving the Visualizer, and Escape closes them", async () => {
  const page = await open(chainCards);
  try {
    await ready(page, 5);
    const at = await circle(page, "mid");
    await page.mouse.click(at.x, at.y);
    const dialog = page.getByRole("dialog");
    await dialog.getByText("mid card").first().waitFor();
    assert.match(new URL(page.url()).pathname, /\/board\/board\/visualizer$/);
    assert.equal(await page.locator("[data-visualizer-canvas]").count(), 1, "the graph is still mounted");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-visualizer-canvas]").count(), 1);
  } finally { await page.close(); }
});

test("the header counts cards per state and the Done filter defaults to Relevant", async () => {
  const page = await open([...chainCards, card("old", "done"), card("older", "archived")]);
  try {
    const count = (state: string) => page.locator(`[data-viz-count="${state}"] b`).textContent();
    await page.locator('[data-viz-count="done"]').waitFor();
    assert.equal(await count("done"), "3", "counts include Done cards the filter hides");
    assert.equal(await count("working"), "1");
    assert.equal(await count("ready"), "1");
    assert.ok(await page.getByRole("list", { name: "Legend" }).getByText("Blocked").isVisible(), "the legend is shown");
    const done = page.getByRole("group", { name: "Done cards" });
    assert.equal(await done.getByRole("button", { name: "Relevant" }).getAttribute("aria-pressed"), "true");
    await ready(page, 5);
    await done.getByRole("button", { name: "All" }).click();
    await ready(page, 7);
    await done.getByRole("button", { name: "Hide" }).click();
    await ready(page, 4);
    assert.equal(await page.locator('[data-viz-label="root"]').count(), 0, "Hide drops Done cards even when something depends on them");
    await page.reload();
    assert.equal(await page.getByRole("group", { name: "Done cards" }).getByRole("button", { name: "Hide" }).getAttribute("aria-pressed"), "true", "the filter is remembered");
  } finally { await page.close(); }
});

test("without WebGL the graph is plain SVG with state colors, labels, hover and click", async () => {
  const noGl = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await noGl.addInitScript(`
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type) {
        return /webgl/.test(type) ? null : getContext.apply(this, arguments);
      };
    `);
    const data: Record<string, unknown> = {
      "/api/boards": [{ id: "board", repo: "/tmp/repo", autoCollapseEmptySwimlanes: false }],
      "/api/settings": { confirmRunStart: false, cardDetailsLayout: "dialog", theme: "default" },
      "/api/boards/board/cards": chainCards,
      "/api/boards/board/conflicts": [],
    };
    await noGl.route("**/api/**", route => route.fulfill({ json: data[new URL(route.request().url()).pathname] ?? [] }));
    await noGl.goto(new URL("/board/board/visualizer", url).href);
    await noGl.locator("[data-visualizer-svg] [data-viz-node]").first().waitFor();
    assert.equal(await noGl.locator("[data-visualizer-canvas]").count(), 0, "no WebGL canvas");
    assert.equal(await noGl.locator("[data-viz-node]").count(), 5);
    assert.equal(await noGl.locator("[data-viz-edge]").count(), 3);
    const mid = noGl.locator('[data-viz-node="mid"]');
    assert.match((await mid.textContent())!, /mid card.*running · turn 2/);
    const stroke = (id: string) => noGl.locator(`[data-viz-node="${id}"] circle`).getAttribute("stroke");
    assert.notEqual(await stroke("mid"), await stroke("alone"), "states get different colors");
    assert.equal(await noGl.locator("[data-visualizer-svg] animate, [data-visualizer-svg] animateTransform").count(), 0, "nothing animates");

    await mid.hover();
    await noGl.waitForFunction(() => document.querySelector('[data-viz-node="alone"]')!.getAttribute("opacity") !== "1");
    assert.equal(await noGl.locator('[data-viz-node="leaf"]').getAttribute("opacity"), "1");
    assert.notEqual(await noGl.locator('[data-viz-node="side"]').getAttribute("opacity"), "1");

    await mid.click();
    await noGl.getByRole("dialog").getByText("mid card").first().waitFor();
    await noGl.keyboard.press("Escape");
    await noGl.getByRole("dialog").waitFor({ state: "detached" });
    assert.ok(await noGl.getByRole("group", { name: "Done cards" }).isVisible(), "header and filter are there too");
  } finally { await noGl.close(); }
});
