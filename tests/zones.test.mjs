import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_ACTIVE_WORKERS, checkZone } from "../scripts/lib/zones.mjs";
import { makeProject } from "./helpers.mjs";

function zoneIn(project, rel) {
  const dir = path.join(project, rel);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const code = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code;
  }
};
const same = (a, b) => assert.equal(a.toLowerCase(), fs.realpathSync.native(b).toLowerCase());

test("a plain sub-folder is accepted and returned as its real path; max workers is 2", () => {
  const project = makeProject("zone-ok");
  const zone = zoneIn(project, "src/feature");
  same(checkZone({ project, zone }), zone);
  assert.equal(MAX_ACTIVE_WORKERS, 2);
});

test("relative, outside, root, missing and file zones are rejected", () => {
  const project = makeProject("zone-bad");
  assert.equal(code(() => checkZone({ project, zone: "src/feature" })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: project })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: path.resolve(project, "..") })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: path.join(project, "missing") })), "bad_zone");
  const file = path.join(project, "file.txt");
  fs.writeFileSync(file, "x");
  assert.equal(code(() => checkZone({ project, zone: file })), "bad_zone");
});

test("zones under TEMP are rejected", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-zone-"));
  const zone = zoneIn(project, "z");
  assert.equal(code(() => checkZone({ project, zone })), "bad_zone");
  fs.rmSync(project, { recursive: true, force: true });
});

test(".tandem is off limits except .tandem/design/<N>/codex; shared folders are rejected as zone or inside it", () => {
  const project = makeProject("zone-forbidden");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".tandem/plans") })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".tandem") })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".tandem/design") })), "bad_zone");
  same(checkZone({ project, zone: zoneIn(project, ".tandem/design/1/codex") }), path.join(project, ".tandem/design/1/codex"));
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".tandem/design/1/claude") })), "bad_zone", "only the codex variant is a zone");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".tandem/design/1/codex/sub") })), "bad_zone", "exactly <N>/codex");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".tandem/design/x/codex") })), "bad_zone", "<N> must be a number");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, "node_modules/pkg") })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".git/hooks") })), "bad_zone");
  const withCache = zoneIn(project, "app");
  zoneIn(project, "app/dist");
  assert.equal(code(() => checkZone({ project, zone: withCache })), "bad_zone");
  if (process.platform === "win32") {
    const upper = zoneIn(project, "app2");
    zoneIn(project, "app2/Dist");
    assert.equal(code(() => checkZone({ project, zone: upper })), "bad_zone", "case-insensitive on Windows");
    assert.equal(code(() => checkZone({ project, zone: zoneIn(project, "NODE_MODULES/x") })), "bad_zone");
  }
});

test("reparse points inside the zone, as the zone, or in an ancestor are rejected", () => {
  const project = makeProject("zone-link");
  const zone = zoneIn(project, "zone");
  const target = zoneIn(project, "elsewhere");
  fs.symlinkSync(target, path.join(zone, "link"), "junction");
  assert.equal(code(() => checkZone({ project, zone })), "bad_zone");
  const asZone = path.join(project, "zone-link");
  fs.symlinkSync(target, asZone, "junction");
  assert.equal(code(() => checkZone({ project, zone: asZone })), "bad_zone");
  const viaAncestor = path.join(asZone, "deep");
  fs.mkdirSync(path.join(target, "deep"));
  assert.equal(code(() => checkZone({ project, zone: viaAncestor })), "bad_zone", "ancestor junction inside the project");
  const outside = fs.mkdtempSync(path.join(path.dirname(project), "outside-"));
  fs.mkdirSync(path.join(outside, "z"));
  fs.symlinkSync(outside, path.join(project, "out"), "junction");
  assert.equal(code(() => checkZone({ project, zone: path.join(project, "out", "z") })), "bad_zone", "ancestor junction pointing outside the project");
});

test("zones must not overlap active zones", () => {
  const project = makeProject("zone-overlap");
  const active = zoneIn(project, "a");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, "a/sub"), activeZones: [active] })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: active, activeZones: [active] })), "bad_zone");
  same(checkZone({ project, zone: zoneIn(project, "b"), activeZones: [active] }), path.join(project, "b"));
});

test("hard-linked files inside the zone are rejected (their data also lives outside the zone)", () => {
  const project = makeProject("zone-hardlink");
  const zone = zoneIn(project, "src/linked");
  const outside = path.join(project, "shared.txt");
  fs.writeFileSync(outside, "shared");
  fs.linkSync(outside, path.join(zone, "alias.txt"));
  let error = null;
  try {
    checkZone({ project, zone });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, "bad_zone");
  assert.match(error.message, /hard-linked/);
  fs.unlinkSync(path.join(zone, "alias.txt"));
  same(checkZone({ project, zone }), zone); // a single link is an ordinary file again
});
