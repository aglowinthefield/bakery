import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyAgentModels, parseAgentModels, parseModelList, piModelArgs, resolveAgentModel, validateAgentModels } from "../server/agent-models.js";

test("agent model input fills missing phases and rejects unknown phases, flags, and thinking levels", () => {
  assert.deepEqual(validateAgentModels({}), emptyAgentModels());
  assert.deepEqual(validateAgentModels({ review: { model: " openai-codex/gpt-5.5 ", thinking: "high" }, work: { thinking: "off" } }),
    { ...emptyAgentModels(), review: { model: "openai-codex/gpt-5.5", thinking: "high" }, work: { model: "", thinking: "off" } });
  assert.equal(validateAgentModels({ work: { model: "sonnet:high" } }).work.model, "sonnet:high");
  for (const input of [null, [], "x", { deploy: {} }, { work: "anthropic/x" }, { work: { model: "a", extra: 1 } },
    { work: { model: "--help" } }, { work: { model: "-x" } }, { work: { model: "has space" } }, { work: { model: "a;rm" } },
    { work: { model: "a".repeat(201) } }, { work: { model: 5 } }, { work: { thinking: "huge" } }, { work: { thinking: null } }])
    assert.throws(() => validateAgentModels(input), /agentModels|agent phase/, JSON.stringify(input));
  assert.deepEqual(parseAgentModels("not json"), emptyAgentModels());
  assert.deepEqual(parseAgentModels('{"conflict":{"model":"anthropic/claude-sonnet-4-5","thinking":""}}').conflict.model, "anthropic/claude-sonnet-4-5");
});

test("repository values override global values per field, and only set fields become Pi flags", () => {
  const global = validateAgentModels({ work: { model: "anthropic/claude-sonnet-4-5", thinking: "medium" }, review: { thinking: "high" } });
  const repo = validateAgentModels({ work: { model: "openai-codex/gpt-5.5" }, conflict: { thinking: "low" } });
  assert.deepEqual(resolveAgentModel("work", repo, global), { model: "openai-codex/gpt-5.5", thinking: "medium" });
  assert.deepEqual(resolveAgentModel("conflict", repo, global), { model: "", thinking: "low" });
  assert.deepEqual(resolveAgentModel("review", repo, global), { model: "", thinking: "high" });
  assert.deepEqual(resolveAgentModel("review", undefined, emptyAgentModels()), { model: "", thinking: "" });
  assert.deepEqual(piModelArgs({ model: "", thinking: "" }), []);
  assert.deepEqual(piModelArgs({ model: "", thinking: "high" }), ["--thinking", "high"]);
  assert.deepEqual(piModelArgs({ model: "openai-codex/gpt-5.5", thinking: "xhigh" }), ["--model", "openai-codex/gpt-5.5", "--thinking", "xhigh"]);
});

test("pi --list-models output becomes provider/model strings", () => {
  const output = `provider     model                     context  max-out  thinking  images
anthropic    claude-sonnet-4-5         200K     64K      yes       yes
openai-codex gpt-5.5                   400K     128K     yes       yes
anthropic    claude-sonnet-4-5         200K     64K      yes       yes

`;
  assert.deepEqual(parseModelList(output), ["anthropic/claude-sonnet-4-5", "openai-codex/gpt-5.5"]);
  assert.deepEqual(parseModelList(""), []);
});
