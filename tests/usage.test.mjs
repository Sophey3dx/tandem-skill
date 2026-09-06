import test from "node:test";
import assert from "node:assert/strict";
import { extractUsage, usageFromEvents, usageFromStderr } from "../scripts/lib/usage.mjs";

const EVENTS = [
  { type: "thread.started", thread_id: "t1" },
  { type: "turn.started" },
  { type: "turn.completed", usage: { input_tokens: 30063, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } }
];

test("usageFromEvents reads turn.completed", () => {
  assert.deepEqual(usageFromEvents(EVENTS), { input: 30063, output: 7, total: 30070, runs: 1 });
  assert.equal(usageFromEvents([{ type: "turn.started" }]), null);
});

test("usageFromStderr parses de-DE and en-US thousands separators", () => {
  assert.deepEqual(usageFromStderr("foo\ntokens used\n57.717\n"), { input: 0, output: 0, total: 57717, runs: 1 });
  assert.deepEqual(usageFromStderr("tokens used\r\n57,717\r\n"), { input: 0, output: 0, total: 57717, runs: 1 });
  assert.equal(usageFromStderr("nothing here"), null);
});

test("extractUsage prefers events over stderr", () => {
  assert.equal(extractUsage({ events: EVENTS, stderr: "tokens used\n1\n" }).total, 30070);
  assert.equal(extractUsage({ events: [], stderr: "tokens used\n1.234\n" }).total, 1234);
  assert.equal(extractUsage({ events: [], stderr: "" }), null);
});
