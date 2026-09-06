import test from "node:test";
import assert from "node:assert/strict";
import { CONFINEMENTS, detectConfinement } from "../scripts/lib/confinement.mjs";

test("confinement detection names the OS mechanism and honours the test override", () => {
  const detected = detectConfinement({ ...process.env, TANDEM_TEST_CONFINEMENT: undefined });
  assert.ok(CONFINEMENTS.includes(detected.kind));
  if (process.platform === "win32") assert.equal(detected.kind, "job");
  if (process.platform === "darwin") assert.equal(detected.kind, "none");
  assert.equal(detectConfinement({ TANDEM_TEST_CONFINEMENT: "none" }).kind, "none");
  assert.equal(detectConfinement({ TANDEM_TEST_CONFINEMENT: "systemd-scope" }).kind, "systemd-scope");
  assert.throws(() => detectConfinement({ TANDEM_TEST_CONFINEMENT: "bogus" }), /TANDEM_TEST_CONFINEMENT/);
});
