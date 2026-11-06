import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

// Set COLLEAGUES_SCREENSHOTS=<dir> to save fixture screenshots while walking the flow.
const shots = process.env.COLLEAGUES_SCREENSHOTS;
let server: ViteDevServer;
let browser: Browser;
let url: string;

before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}prototype-colleagues.html`;
  browser = await chromium.launch();
  if (shots) mkdirSync(shots, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });

test("operator walks colleagues, room, queue and steer, standup, context and simulated handoff without writes", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const problems: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", error => problems.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (message.type() === "error" || message.type() === "warning") problems.push(`${message.type()}: ${message.text()}`); });
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api") || request.method() !== "GET") requests.push(`${request.method()} ${path}`); });
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
  const send = async (text: string) => { await page.getByRole("textbox", { name: "Message", exact: true }).fill(text); await page.getByRole("button", { name: "Send", exact: true }).click(); };
  const advance = () => page.getByRole("button", { name: "Advance fixture round" }).click();

  await page.goto(url);
  await page.getByRole("status").first().getByText("Prototype / fixture data").waitFor();
  await page.getByRole("article", { name: "Ingest" }).waitFor();
  assert.equal(await page.getByRole("article").count(), 3);
  await shot("01-colleagues");

  // Start a direct room, then add Scout and a group room context.
  await page.getByRole("article", { name: "Ingest" }).getByRole("button", { name: "Start chat" }).click();
  await page.getByRole("heading", { name: "Chat with Ingest" }).waitFor();
  await page.getByRole("button", { name: "Rooms" }).first().click();
  await page.getByRole("button", { name: "New room" }).click();
  await page.getByLabel("Topic").fill("Ingestion quality");
  await page.getByLabel("Ingest").check();
  await page.getByLabel("Scout").check();
  await page.getByLabel("Silk").check();
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Ingestion quality" }).waitFor();

  // Lead reply plus one interjection.
  await send("How should we retry enrichment without duplicating media?");
  await advance();
  await advance();
  const transcript = page.getByRole("list", { name: "Transcript" });
  await transcript.getByText("Retry the enrichment stage against the existing media record").waitFor();
  await transcript.getByText("One dependency: related-media ranking").waitFor();
  assert.equal(await transcript.getByText("Interjection", { exact: true }).count(), 1);
  await shot("02-room-interjection");

  // Context used.
  await page.getByRole("button", { name: /Context used · 3 memories/ }).first().click();
  const used = page.getByRole("region", { name: "Context used" });
  await used.getByText("imp_7f3a21").waitFor();
  await used.getByText(/Staleness warning/).waitFor();
  await shot("03-context-used");

  // Queue two messages while a round runs, then steer the second.
  await send("Compare this with last week's failure.");
  await page.getByText("Ingest is responding…").waitFor();
  await send("Preserve the schema. No migration.");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await queue.getByText("Queued messages · 1").waitFor();
  await send("A third queued message.");
  await queue.getByText("Queued messages · 2").waitFor();
  await shot("04-queued");
  await queue.getByRole("listitem").filter({ hasText: "Preserve the schema" }).getByRole("button", { name: "Steer now" }).click();
  await transcript.getByText(/Steered:/).waitFor();
  await transcript.getByText("Interrupted", { exact: true }).waitFor();
  assert.equal(await queue.getByRole("listitem").count(), 1);
  assert.equal(await transcript.getByText("Preserve the schema. No migration.", { exact: true }).count(), 1);
  await shot("05-steered");

  // Stop and resume.
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByText("Queue paused. New messages").waitFor();
  await page.getByRole("button", { name: "Simulate late output from stopped round" }).click();
  await transcript.getByText(/Discarded late output/).waitFor();
  await page.getByRole("button", { name: "Resume queue" }).click();
  await page.getByText(/is responding/).waitFor();
  for (let i = 0; i < 6 && await page.getByRole("button", { name: "Advance fixture round" }).count(); i++) await advance();
  assert.equal(await transcript.getByText("A third queued message.", { exact: true }).count(), 1);
  assert.equal(await transcript.getByText("Preserve the schema. No migration.", { exact: true }).count(), 1);
  await shot("06-after-resume");

  // Standup with a partial failure.
  await page.getByRole("button", { name: "Run standup" }).click();
  const standup = page.getByRole("region", { name: "Standup" });
  await standup.getByText("Summary · partial").waitFor();
  await standup.getByText("Update unavailable").waitFor();
  await shot("07-standup-partial");
  await standup.getByRole("button", { name: "Retry report" }).click();
  await standup.getByText("Summary · complete").waitFor();

  // Handoff with Triage override; creating twice yields one simulated card.
  await standup.getByRole("button", { name: "Create card…" }).first().click();
  await page.getByRole("heading", { name: "Create card" }).waitFor();
  await page.getByText(/Simulated handoff/).waitFor();
  const create = page.getByRole("button", { name: /simulated card/ });
  assert.match(await create.innerText(), /Create & queue work/);
  await page.getByRole("combobox", { name: /^Board/ }).selectOption("silk");
  await page.getByText("Auto pickup is on. Creating this card queues paid work.").waitFor();
  await shot("08-handoff-ready");
  await page.getByLabel("Destination").selectOption("triage");
  assert.match(await create.innerText(), /Create in Triage/);
  await page.getByText("Triage holds the card for review. Nothing runs.").waitFor();
  await create.click();
  await page.getByText(/Simulated card · not a real Bakery card/).waitFor();
  assert.equal(await page.getByText(/Simulated card · not a real Bakery card/).count(), 1);
  await shot("09-simulated-card");

  // Reset clears everything.
  await page.getByRole("button", { name: "Reset prototype" }).click();
  await page.getByRole("article", { name: "Ingest" }).waitFor();
  await page.getByRole("button", { name: "Rooms" }).first().click();
  await page.getByText("No fixture rooms yet.").waitFor();

  assert.deepEqual(requests, []);
  assert.deepEqual(problems, []);
  await page.close();
});
