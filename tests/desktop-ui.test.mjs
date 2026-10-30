import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

let server;
let browser;
let address;
before(async () => {
  server = createServer(async (req, res) => {
    const name = req.url === "/" ? "index.html" : req.url.slice(1);
    if (
      !["index.html", "connection.js", "connection.css", "icon.png"].includes(
        name,
      )
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(
        new URL(`../desktop/${name}`, import.meta.url),
      );
      res.setHeader(
        "Content-Type",
        name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : name.endsWith(".png")
              ? "image/png"
              : "text/html",
      );
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function open({
  saved = "",
  loadError = false,
  connectError = false,
} = {}) {
  const page = await browser.newPage({ viewport: { width: 620, height: 620 } });
  await page.addInitScript(
    ({ saved, loadError, connectError }) => {
      window.__TAURI__ = {
        core: {
          invoke: async (command) => {
            if (command === "saved_server") {
              if (loadError) throw "Cannot read the saved server address.";
              return saved;
            }
            if (command === "connect") {
              await new Promise((resolve) => setTimeout(resolve, 100));
              if (connectError)
                throw "Cannot reach Bakery. Check the address and your Tailnet connection.";
              return null;
            }
            throw new Error(`Unexpected command: ${command}`);
          },
        },
      };
    },
    { saved, loadError, connectError },
  );
  await page.goto(address);
  await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
  return page;
}

test("the launcher restores the address and connects without duplicate submissions", async () => {
  const page = await open({ saved: "https://bakery.example.ts.net/" });
  try {
    const input = page.getByLabel("Server address");
    await page.waitForFunction(
      () => document.querySelector("input").value !== "",
    );
    assert.equal(await input.inputValue(), "https://bakery.example.ts.net/");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    assert.equal(
      await page.getByRole("button", { name: "Connecting…" }).isDisabled(),
      true,
    );
    await page
      .getByRole("status")
      .filter({ hasText: "Bakery is open" })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .isEnabled(),
      true,
    );
  } finally {
    await page.close();
  }
});

test("a failed connection leaves the address editable and explains recovery", async () => {
  const page = await open({ connectError: true });
  try {
    await page
      .getByLabel("Server address")
      .fill("https://bakery.example.ts.net");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Check the address and your Tailnet" })
      .waitFor();
    assert.equal(await page.getByLabel("Server address").isEnabled(), true);
    assert.equal(
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .isEnabled(),
      true,
    );
  } finally {
    await page.close();
  }
});

test("a damaged settings file does not prevent entering a new address", async () => {
  const page = await open({ loadError: true });
  try {
    await page
      .getByRole("alert")
      .filter({ hasText: "Cannot read the saved" })
      .waitFor();
    await page.getByLabel("Server address").fill("http://127.0.0.1:4317");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Bakery is open" })
      .waitFor();
  } finally {
    await page.close();
  }
});
