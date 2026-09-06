import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  acquireLock, addUsage, defaultState, emptyUsage, loadState, saveState, stateExists, withLock
} from "../scripts/lib/state.mjs";
import { tandemLayout } from "../scripts/lib/paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
function project() {
  const root = path.join(HERE, ".tmp");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, "state-"));
}

test("save/load roundtrip, backup on second save", () => {
  const dir = project();
  assert.equal(stateExists(dir), false);
  const state = defaultState(dir);
  saveState(dir, state);
  assert.equal(stateExists(dir), true);
  assert.equal(loadState(dir).mode, "begleiter");
  state.mode = "plan";
  saveState(dir, state);
  const { backupFile } = tandemLayout(dir);
  assert.equal(JSON.parse(fs.readFileSync(backupFile, "utf8")).mode, "begleiter");
  assert.equal(loadState(dir).mode, "plan");
});

test("loadState reports missing and corrupt state", () => {
  const dir = project();
  assert.throws(() => loadState(dir), (e) => e.code === "not_started");
  const { stateFile, root } = tandemLayout(dir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(stateFile, "{not json", "utf8");
  assert.throws(() => loadState(dir), (e) => e.code === "state_corrupt");
});

test("lock: live foreign pid blocks, dead or old lock is stale", () => {
  const dir = project();
  const { lockFile, root } = tandemLayout(dir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
  assert.throws(() => acquireLock(dir), (e) => e.code === "locked");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  acquireLock(dir)();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
  const release = acquireLock(dir);
  assert.equal(fs.existsSync(lockFile), true);
  release();
  assert.equal(fs.existsSync(lockFile), false);
});

test("withLock releases even when fn throws", async () => {
  const dir = project();
  await assert.rejects(withLock(dir, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(tandemLayout(dir).lockFile), false);
});

test("release only removes the caller's own lock", () => {
  const dir = project();
  const { lockFile } = tandemLayout(dir);
  const release = acquireLock(dir);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "someone-else" }));
  release();
  assert.equal(fs.existsSync(lockFile), true, "foreign lock must survive");
  fs.unlinkSync(lockFile);
});

test("acquireLock is atomic across processes", async () => {
  const dir = project();
  const stateUrl = new URL("../scripts/lib/state.mjs", import.meta.url).href;
  const script = `import { acquireLock } from ${JSON.stringify(stateUrl)}; const release = acquireLock(process.argv[1]); setTimeout(() => { release(); }, 1500);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.throws(() => acquireLock(dir), (e) => e.code === "locked");
  await new Promise((resolve) => child.on("exit", resolve));
  acquireLock(dir)();
});

test("addUsage sums into total, session and byKind", () => {
  const state = defaultState("x");
  addUsage(state, "checkpoint", { input: 100, output: 20, total: 120, runs: 1 });
  addUsage(state, "checkpoint", { input: 50, output: 5, total: 55, runs: 1 });
  addUsage(state, "plan", null);
  assert.deepEqual(state.usage.total, { input: 150, output: 25, total: 175, runs: 2 });
  assert.deepEqual(state.usage.byKind.checkpoint, { input: 150, output: 25, total: 175, runs: 2 });
  assert.deepEqual(state.usage.session, { input: 150, output: 25, total: 175, runs: 2 });
  assert.deepEqual(emptyUsage(), { input: 0, output: 0, total: 0, runs: 0 });
});
