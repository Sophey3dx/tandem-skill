import test from "node:test";
import assert from "node:assert/strict";
import { budgetViolation, ensureBudget, minRemainingOf, normalizeRateLimits, readRateLimits } from "../scripts/lib/ratelimits.mjs";
import { defaultState } from "../scripts/lib/state.mjs";
import { FAKE } from "./helpers.mjs";

const env = (extra = {}) => ({ ...process.env, TANDEM_CODEX_BIN: FAKE, ...extra });

test("normalizeRateLimits converts percent and unix seconds", () => {
  const limits = normalizeRateLimits({ rateLimits: { primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1788671480 }, secondary: null, planType: "plus", rateLimitReachedType: null } });
  assert.equal(limits.primary.remainingPercent, 82);
  assert.equal(limits.primary.resetsAt, new Date(1788671480 * 1000).toISOString());
  assert.equal(limits.secondary, null);
  assert.equal(limits.planType, "plus");
});

test("minRemainingOf reads the option or returns undefined", () => {
  assert.equal(minRemainingOf({ "min-remaining": "0" }), 0);
  assert.equal(minRemainingOf({}), undefined);
});

test("budgetViolation finds the first window under the threshold", () => {
  const limits = normalizeRateLimits({ rateLimits: { primary: { usedPercent: 95, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2 } } });
  assert.deepEqual(budgetViolation(limits, 10), { window: "5h", remainingPercent: 5, resetsAt: "1970-01-01T00:00:01.000Z" });
  assert.equal(budgetViolation(limits, 5), null);
  assert.equal(budgetViolation({ error: "timeout" }, 10), null);
});

test("readRateLimits talks JSON-RPC to the fake app-server", async () => {
  const limits = await readRateLimits({ env: env({ FAKE_USED_PRIMARY: "42" }), timeoutMs: 10000 });
  assert.equal(limits.primary.usedPercent, 42);
  assert.equal(limits.secondary.usedPercent, 6);
});

test("ensureBudget throws quota_low under threshold, passes with --min-remaining 0", async () => {
  const state = defaultState("x");
  await assert.rejects(ensureBudget(state, { env: env({ FAKE_USED_PRIMARY: "97" }) }), (e) => e.code === "quota_low");
  assert.equal(state.rateLimits.primary.usedPercent, 97);
  const limits = await ensureBudget(state, { env: env({ FAKE_USED_PRIMARY: "97" }), minRemaining: 0 });
  assert.equal(limits.primary.remainingPercent, 3);
});

test("guard fails open when the query errors, times out or crashes", async () => {
  const state = defaultState("x");
  const errored = await readRateLimits({ env: env({ FAKE_RATELIMIT_MODE: "error" }), timeoutMs: 10000 });
  assert.equal(errored.error, "fake rate limit error");
  const silent = await readRateLimits({ env: env({ FAKE_RATELIMIT_MODE: "silent" }), timeoutMs: 1500 });
  assert.equal(silent.error, "timeout");
  const crashed = await readRateLimits({ env: env({ FAKE_RATELIMIT_MODE: "crash" }), timeoutMs: 10000 });
  assert.ok(crashed.error);
  const limits = await ensureBudget(state, { env: env({ FAKE_RATELIMIT_MODE: "error", FAKE_USED_PRIMARY: "99" }) });
  assert.equal(limits.error, "fake rate limit error");
  assert.equal(state.rateLimits.error, "fake rate limit error");
});

test("minRemainingOf validates the range", () => {
  for (const bad of ["abc", "-1", "101", "Infinity"]) {
    assert.throws(() => minRemainingOf({ "min-remaining": bad }), (e) => e.code === "bad_config", bad);
  }
});
