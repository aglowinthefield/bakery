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

const settings = { confirmRunStart: false, notifyOnReview: false, cardDetailsLayout: "dialog", theme: "default" };
const boards = ["a", "b"].map(id => ({ id, repo: `/tmp/${id}`, remoteUrl: `https://github.com/o/${id}.git`, autoCollapseEmptySwimlanes: false }));
const card = { id: "c1", title: "Open card", body: "", repo: "/tmp/a", source: "manual", status: "triage", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 0, turnsIncomplete: 0 };

type Spy = { fades: number; opacities: string[] };

async function open(reducedMotion: "reduce" | "no-preference") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
  await page.addInitScript(() => {
    const spy = { fades: 0, opacities: [] as string[] };
    (window as unknown as { __fades: typeof spy }).__fades = spy;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      if (this.matches("main.page-fade") && (options as KeyframeAnimationOptions)?.duration === 120) {
        spy.fades++;
        spy.opacities.push(JSON.stringify(keyframes));
      }
      return original.call(this, keyframes as Keyframe[], options);
    };
  });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status") return route.fulfill({ json: { draining: false, activeRuns: 0 } });
    if (path === "/api/settings") return route.fulfill({ json: settings });
    if (path === "/api/boards") return route.fulfill({ json: boards });
    if (path === "/api/boards/a/cards") return route.fulfill({ json: [card] });
    return route.fulfill({ json: [] });
  });
  await page.goto(new URL("/board/a", url).href);
  await page.getByRole("button", { name: /Open card/ }).waitFor();
  await page.waitForTimeout(300);
  return page;
}

const fades = (page: Page) => page.evaluate(() => (window as unknown as { __fades: Spy }).__fades.fades);
const go = (page: Page, path: string) => page.evaluate(p => { history.pushState(null, "", p); dispatchEvent(new PopStateEvent("popstate")); }, path);

test("navigation starts one opacity-only fade per page change, including repository switches", async () => {
  const page = await open("no-preference");
  try {
    assert.equal(await fades(page), 0, "initial load does not fade");
    const steps = ["/board/a/pulls", "/board/b/pulls", "/board/b/visualizer", "/board/a/visualizer", "/board/a/chat", "/board/b/chat", "/settings/general", "/board/b", "/board/a", "/today", "/board/a"];
    let expected = 0;
    for (const path of steps) {
      await go(page, path);
      expected++;
      await page.waitForFunction(n => (window as unknown as { __fades: Spy }).__fades.fades >= n, expected, { timeout: 2000 });
      assert.equal(await fades(page), expected, `${path} starts exactly one fade`);
    }
    const spy = await page.evaluate(() => (window as unknown as { __fades: Spy }).__fades.opacities);
    assert.ok(spy.every(k => k === JSON.stringify([{ opacity: 0.88 }, { opacity: 1 }])), "opacity only");
    assert.equal(await page.locator("aside").evaluate(el => el.getAnimations().length), 0, "sidebar is not animated");
  } finally { await page.close(); }
});

test("re-selecting the current page, opening a card and polling do not start a fade", async () => {
  const page = await open("no-preference");
  try {
    await page.getByRole("button", { name: "a", exact: true }).click();
    await page.getByRole("button", { name: /Open card/ }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await go(page, "/board/a");
    await page.evaluate(() => { dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForTimeout(1500);
    assert.equal(await fades(page), 0);
  } finally { await page.close(); }
});

test("prefers-reduced-motion starts no fade", async () => {
  const page = await open("reduce");
  try {
    await go(page, "/board/b/pulls");
    await go(page, "/settings/general");
    await page.getByRole("navigation", { name: "Settings categories" }).waitFor();
    assert.equal(await fades(page), 0);
  } finally { await page.close(); }
});
