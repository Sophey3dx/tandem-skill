import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CONFINEMENTS, detectConfinement, quickScopeGone, scopeState } from "../scripts/lib/confinement.mjs";
import { FAKE_SYSTEMCTL, makeProject } from "./helpers.mjs";

test("confinement detection names the OS mechanism and honours the test override", () => {
  const detected = detectConfinement({ ...process.env, TANDEM_TEST_CONFINEMENT: undefined });
  assert.ok(CONFINEMENTS.includes(detected.kind));
  if (process.platform === "win32") assert.equal(detected.kind, "job");
  if (process.platform === "darwin") assert.equal(detected.kind, "none");
  assert.equal(detectConfinement({ TANDEM_TEST_CONFINEMENT: "none" }).kind, "none");
  assert.equal(detectConfinement({ TANDEM_TEST_CONFINEMENT: "systemd-scope" }).kind, "systemd-scope");
  assert.throws(() => detectConfinement({ TANDEM_TEST_CONFINEMENT: "bogus" }), /TANDEM_TEST_CONFINEMENT/);
});

test("scopeState: inactive/failed and a provably missing unit are gone; an unreachable manager is unknown; active is active", () => {
  const dir = makeProject("scope-state");
  const stateFile = path.join(dir, "state.txt");
  const env = { ...process.env, TANDEM_TEST_SYSTEMCTL: FAKE_SYSTEMCTL, FAKE_SYSTEMCTL_STATE_FILE: stateFile };
  const withState = (lines) => {
    fs.writeFileSync(stateFile, `${lines.join("\n")}\n`, "utf8");
    return scopeState("tandem-worker-1", env);
  };
  assert.equal(withState(["active"]), "active");
  assert.equal(withState(["deactivating"]), "active");
  assert.equal(withState(["inactive"]), "gone");
  assert.equal(withState(["failed"]), "gone");
  assert.equal(withState(["unknown"]), "gone", "a collected scope is not loaded any more: LoadState not-found");
  assert.equal(withState(["unknown", "loaded"]), "unknown", "unknown state for a loaded unit is not proof of anything");
  assert.equal(withState(["", ""]), "gone", "the fake's default state is inactive");
  assert.equal(scopeState("tandem-worker-1", { ...env, TANDEM_TEST_SYSTEMCTL: path.join(dir, "missing-systemctl.mjs") }), "unknown", "systemctl not answering is unknown, never gone");
  // The runner's quick check: one kill, one look.
  fs.writeFileSync(stateFile, "active\n", "utf8");
  assert.equal(quickScopeGone("tandem-worker-1", { ...env, FAKE_SYSTEMCTL_KILL: "fail" }), false);
  fs.writeFileSync(stateFile, "unknown\n", "utf8");
  assert.equal(quickScopeGone("tandem-worker-1", env), true);
});
