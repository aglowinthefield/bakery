import { test } from "node:test";
import assert from "node:assert/strict";
import { addAgent, agentLabel, agentsInStream } from "../server/agent.js";

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
