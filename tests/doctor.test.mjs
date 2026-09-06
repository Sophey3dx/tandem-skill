import test from "node:test";
import assert from "node:assert/strict";
import { makeProject, runTandem } from "./helpers.mjs";

test("doctor reports readiness with the fake codex", () => {
  const dir = makeProject("doctor");
  const { status, json } = runTandem(["doctor"], { cwd: dir });
  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.equal(json.ready, true);
  assert.equal(json.codex.version, "9.9.9");
  assert.equal(json.codex.login.loggedIn, true);
  assert.equal(json.started, false);
  assert.equal(json.rateLimits.primary.usedPercent, 18);
});

test("unknown command exits 1 with a JSON error", () => {
  const { status, json } = runTandem(["nope"], { cwd: makeProject("cmd") });
  assert.equal(status, 1);
  assert.equal(json.ok, false);
  assert.equal(json.error, "unknown_command");
});

test("help lists commands", () => {
  const { status, json } = runTandem(["help"], { cwd: makeProject("help") });
  assert.equal(status, 0);
  assert.ok(json.commands.includes("doctor"));
});
