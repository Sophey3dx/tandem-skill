import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { captureStartTime, processStartTime, sameProcess, sleepSync } from "../scripts/lib/procs.mjs";

test("processStartTime reports the start of a live process and null for a dead pid", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const start = captureStartTime(child.pid);
  assert.ok(Number.isFinite(start), "start time must be captured right after spawn");
  assert.equal(processStartTime(child.pid), start);
  assert.ok(Math.abs(Date.now() - start) < 60 * 1000, "start time must be recent");
  assert.equal(sameProcess({ pid: child.pid, procStart: start }), true);
  assert.equal(sameProcess({ pid: child.pid, procStart: start - 60 * 1000 }), false, "a different start time means a different process");
  for (const deltaMs of [1000, 2000, 4000, 5000, -1000]) {
    assert.equal(sameProcess({ pid: child.pid, procStart: start + deltaMs }), false, `a start time off by ${deltaMs} ms is a foreign process`);
  }
  assert.equal(sameProcess({ pid: child.pid, procStart: null }), true, "unknown identity only tells liveness (callers must never kill on it)");
  assert.equal(captureStartTime(999999, { attempts: 2, waitMs: 10 }), null);
  child.kill();
  await new Promise((resolve) => child.on("exit", resolve));
  sleepSync(200);
  assert.equal(processStartTime(child.pid), null);
  assert.equal(sameProcess({ pid: child.pid, procStart: start }), false);
  assert.equal(processStartTime(999999), null);
});

test("processState distinguishes alive, foreign, unverified and gone", async () => {
  const { processState } = await import("../scripts/lib/procs.mjs");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const start = captureStartTime(child.pid);
  assert.ok(Number.isFinite(start));
  assert.equal(processState({ pid: child.pid, procStart: start }), "alive");
  assert.equal(processState({ pid: child.pid, procStart: start - 60 * 1000 }), "foreign");
  assert.equal(processState({ pid: child.pid, procStart: null }), "unverified");
  process.env.TANDEM_TEST_START_TIME_FAIL = "1";
  try {
    assert.equal(processState({ pid: child.pid, procStart: start }), "unverified", "a failing query is not 'gone'");
    assert.equal(sameProcess({ pid: child.pid, procStart: start }), true, "liveness survives a failing query");
  } finally {
    delete process.env.TANDEM_TEST_START_TIME_FAIL;
  }
  assert.equal(sameProcess({ pid: child.pid, procStart: start - 60 * 1000 }), false, "a foreign process is not our worker");
  child.kill();
  await new Promise((resolve) => child.on("exit", resolve));
  sleepSync(200);
  assert.equal(processState({ pid: child.pid, procStart: start }), "gone");
  assert.equal(processState({ pid: 999999, procStart: start }), "gone");
});
