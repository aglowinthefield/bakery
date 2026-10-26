import { test } from "node:test";
import assert from "node:assert/strict";
import { addAgent, agentLabel, agentsInStream, messageUsage, usageInStream } from "../server/agent.js";

test("agent labels come from assistant provider and model only", () => {
  assert.equal(agentLabel({ role: "assistant", provider: "anthropic", model: "claude-opus-4-1" }), "anthropic/claude-opus-4-1");
  assert.equal(agentLabel({ role: "assistant", provider: "openai-codex", model: "gpt-5.5" }), "openai-codex/gpt-5.5");
  assert.equal(agentLabel({ role: "user", provider: "anthropic", model: "claude" }), null);
  assert.equal(agentLabel({ role: "assistant" }), null);
  assert.equal(agentLabel({ role: "assistant", provider: "evil<script>", model: "a b\nc" }), "evilscript/abc");
});

test("distinct agents are kept in first-use order and bounded", () => {
  let agents = addAgent("", "anthropic/claude");
  agents = addAgent(agents, "anthropic/claude");
  agents = addAgent(agents, "openai-codex/gpt-5.5");
  assert.equal(agents, "anthropic/claude, openai-codex/gpt-5.5");
  for (const label of ["a/1", "b/2", "c/3"]) agents = addAgent(agents, label);
  assert.equal(agents.split(", ").length, 4);
  const stream = [
    JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.5" } }),
    "not json",
    JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.5" } }),
  ].join("\n");
  assert.equal(agentsInStream(stream), "openai-codex/gpt-5.5");
});

test("usage comes from assistant message_end events and ignores malformed values", () => {
  const usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 460, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0125 } };
  assert.deepEqual(messageUsage({ role: "assistant", usage }), { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40, cost: 0.0125 });
  assert.equal(messageUsage({ role: "user", usage }), null);
  assert.equal(messageUsage({ role: "assistant" }), null);
  assert.deepEqual(messageUsage({ role: "assistant", usage: { input: -5, output: "9", cost: { total: Number.NaN } } }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 });
  const stream = [
    JSON.stringify({ type: "message_start", message: { role: "assistant", usage } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", usage } }),
    "not json",
    JSON.stringify({ type: "message_end", message: { role: "assistant", usage } }),
  ].join("\n");
  assert.deepEqual(usageInStream(stream), { inputTokens: 200, outputTokens: 40, cacheReadTokens: 600, cacheWriteTokens: 80, cost: 0.025 });
});
