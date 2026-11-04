import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createViteServer } from "vite";
import config from "../vite.config.js";

test("Vite rewrites same-origin UI requests but preserves unrelated origins for API rejection", async () => {
  const targetOrigin = new URL(process.env.BAKERY_API_TARGET ?? "http://127.0.0.1:4317").origin;
  const api = createServer((req, res) => {
    const origin = req.headers.origin;
    res.writeHead(origin === targetOrigin ? 200 : 403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ origin }));
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const proxy = config.server!.proxy!["/api"];
  assert.ok(typeof proxy !== "string");
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const uiAddress = reserve.address();
  assert.ok(uiAddress && typeof uiAddress !== "string");
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const vite = await createViteServer({
    ...config, configFile: false, plugins: [], optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...config.server, port: uiAddress.port, proxy: { "/api": { ...proxy, target: `http://127.0.0.1:${address.port}` } } },
  });
  try {
    await vite.listen();
    const ui = vite.httpServer!.address();
    assert.ok(ui && typeof ui !== "string");
    const url = `http://127.0.0.1:${ui.port}`;
    for (const origin of [url, "https://untrusted.example", "http://127.0.0.1:49000", "null"]) {
      const response = await fetch(`${url}/api/probe`, { method: "POST", headers: { Origin: origin } });
      assert.equal(response.status, origin === url ? 200 : 403, origin);
      assert.equal((await response.json()).origin, origin === url ? targetOrigin : origin);
    }
  } finally {
    await vite.close();
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  }
});
