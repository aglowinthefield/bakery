import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyProviderFailure } from "../server/provider-failure.js";

const history = (index: number) => `Provider request failed (HTTP 400): 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.${index}: role 'system' must precede an 'assistant' message or end the array; the directive-only form (content: [] with output_config) is accepted at any position"},"request_id":"req_x"}`;

test("a 400 that points into the messages array is an invalid history, whatever the index", () => {
  assert.equal(classifyProviderFailure(history(105)), "invalid-history");
  assert.equal(classifyProviderFailure(history(503)), "invalid-history", "a message index is not an HTTP status");
  assert.equal(classifyProviderFailure(`Provider request failed (HTTP 400): 400 {"error":{"type":"invalid_request_error","message":"messages.32.content.0: tool_addition/tool_removal references unknown tool 'compress'","details":{"error_code":"tool_reference_unresolved"}}}`), "invalid-history");
});

test("the recorded fixture error classifies as an invalid history", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/poisoned-session-request.json", import.meta.url), "utf8"));
  assert.equal(classifyProviderFailure(`Provider request failed (HTTP 400): ${fixture.provider_error}`), "invalid-history");
});

test("other failures keep their own kinds and are not invalid histories", () => {
  const cases: [string, string][] = [
    ["Provider request failed (HTTP 400): 400 {\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Your credit balance is too low to access the Anthropic API\"}}", "billing"],
    ["Provider request failed (HTTP 401): 401 {\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}", "auth"],
    ["Provider request failed (HTTP 403): 403 forbidden", "auth"],
    ["Provider request failed (HTTP 400): 400 {\"error\":{\"type\":\"invalid_request_error\",\"message\":\"max_tokens: 999999 > 128000\"}}", "invalid-request"],
    ["Provider request failed (HTTP 429): rate_limit_error", "rate-limit"],
    ["Provider request failed (HTTP 503): OpenAI API error (503): upstream", "transient"],
    ["Provider request failed (HTTP 502): 502 {\"error\":\"cannot resolve tunnel destination api.anthropic.com (ETIMEDOUT)\"}", "transient"],
    ["Provider request failed: fetch failed", "transient"],
    ["This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.", "output-blocked"],
    ["Provider request failed", "unknown"],
  ];
  for (const [text, kind] of cases) assert.equal(classifyProviderFailure(text), kind, text);
  assert.equal(classifyProviderFailure(null), "unknown");
});
