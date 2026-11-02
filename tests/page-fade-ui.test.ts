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

type Spy = { fades: number; opacities: string[]; pageAnimations: number };

async function open(reducedMotion: "reduce" | "no-preference") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
  await page.addInitScript(() => {
    const spy = { fades: 0, opacities: [] as string[], pageAnimations: 0 };
    (window as unknown as { __fades: typeof spy }).__fades = spy;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const duration = (options as KeyframeAnimationOptions)?.duration;
      if (this.matches(".page-fade-veil") && duration === 120) {
        spy.fades++;
        spy.opacities.push(JSON.stringify(keyframes));
      }
      // The page itself must never be animated.
      if (this.matches("main, aside") && !this.closest("[role=dialog]")) spy.pageAnimations++;
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
    assert.ok(spy.every(k => k === JSON.stringify([{ opacity: 0.12 }, { opacity: 0 }])), "opacity only");
    assert.equal(await page.evaluate(() => (window as unknown as { __fades: Spy }).__fades.pageAnimations), 0, "no page or sidebar element is animated");
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

test("navigation uses no View Transition, and its pseudo-elements cannot animate", async () => {
  const page = await open("no-preference");
  try {
    await page.evaluate(() => {
      const w = window as unknown as { __vt: number };
      w.__vt = 0;
      const original = document.startViewTransition?.bind(document);
      if (original) document.startViewTransition = ((...args: Parameters<typeof original>) => { w.__vt++; return original(...args); }) as typeof document.startViewTransition;
    });
    for (const path of ["/board/b", "/today", "/board/a/chat", "/settings/general", "/board/a"]) {
      await go(page, path);
      await page.waitForTimeout(250);
    }
    assert.equal(await page.evaluate(() => (window as unknown as { __vt: number }).__vt), 0, "no startViewTransition call");
    // The veil is the only animated element and only changes opacity, uniformly over the page.
    const veil = await page.locator(".page-fade-veil").evaluate(el => { const s = getComputedStyle(el); return { clip: s.clipPath, mask: s.maskImage, transform: s.transform, scale: s.scale, translate: s.translate }; });
    assert.deepEqual(veil, { clip: "none", mask: "none", transform: "none", scale: "none", translate: "none" });
    // Even a transition started elsewhere gets no animation on its pseudo-elements.
    const names = await page.evaluate(async () => {
      if (!document.startViewTransition) return ["unsupported"];
      const t = document.startViewTransition(() => { document.body.dataset.probe = "1"; });
      await t.ready.catch(() => undefined);
      const out = document.documentElement.getAnimations({ subtree: true }).filter(a => (a.effect as KeyframeEffect).pseudoElement?.startsWith("::view-transition")).map(a => (a as CSSAnimation).animationName);
      t.skipTransition();
      return out;
    });
    assert.deepEqual(names.filter(n => n !== "unsupported"), [], "view-transition pseudo-elements have no animation");
  } finally { await page.close(); }
});
