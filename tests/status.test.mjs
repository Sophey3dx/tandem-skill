import test from "node:test";
import assert from "node:assert/strict";
import { makeProject, runTandem, startProject } from "./helpers.mjs";

test("status summarises state, human flag adds text; mode/config/stop work", () => {
  const dir = makeProject("status");
  assert.equal(runTandem(["status"], { cwd: dir }).json.error, "not_started");
  startProject(dir, { FAKE_THREAD_ID: "thread-s" });
  assert.equal(runTandem(["mode", "plan"], { cwd: dir }).json.mode, "plan");
  assert.equal(runTandem(["mode", "turbo"], { cwd: dir }).json.error, "bad_mode");
  assert.equal(runTandem(["config", "--min-remaining", "25"], { cwd: dir }).json.config.minRemainingPercent, 25);
  const { json } = runTandem(["status", "--human"], { cwd: dir });
  assert.equal(json.threadId, "thread-s");
  assert.equal(json.mode, "plan");
  assert.equal(json.usage.total.total, 120);
  assert.equal(json.rateLimits.primary.remainingPercent, 82);
  assert.match(json.human, /thread-s/);
  assert.match(json.human, /82 %/);
  runTandem(["stop"], { cwd: dir });
  assert.equal(runTandem(["status"], { cwd: dir }).json.stopped, true);
});
