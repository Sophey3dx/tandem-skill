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
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lockFile, old, old); // staleness is judged by the inode's mtime (heartbeat target)
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

test("a held lock is refreshed by the heartbeat so it never ages into stale while alive", async () => {
  const dir = project();
  const { lockFile } = tandemLayout(dir);
  const stateUrl = new URL("../scripts/lib/state.mjs", import.meta.url).href;
  // Child holds the lock for ~1.2 s with a 100 ms heartbeat; we watch the timestamp move.
  const script = `import { acquireLock } from ${JSON.stringify(stateUrl)}; const release = acquireLock(process.argv[1]); setTimeout(() => { release(); }, 1200);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir], { stdio: "ignore", env: { ...process.env, TANDEM_LOCK_HEARTBEAT_MS: "100" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const first = fs.statSync(lockFile).mtimeMs;
  const content = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const second = fs.statSync(lockFile).mtimeMs;
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, "utf8")), content, "lock content is immutable");
  assert.ok(second > first, "heartbeat must advance the mtime");
  await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(fs.existsSync(lockFile), false);
});

test("a holder whose lock was taken over cannot save state (lock_lost) and does not delete the new lock", () => {
  const dir = project();
  const { lockFile } = tandemLayout(dir);
  const release = acquireLock(dir);
  const mine = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  // Another process considered us stale, removed our lock and created its own (new inode at the same path).
  fs.unlinkSync(lockFile);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, at: new Date().toISOString(), token: "taken-over" }));
  assert.throws(() => saveState(dir, defaultState(dir)), (e) => e.code === "lock_lost");
  release();
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "taken-over", "the new owner's lock survives our release");
  assert.notEqual(mine.token, "taken-over");
  fs.unlinkSync(lockFile);
  saveState(dir, defaultState(dir)); // without a held lock, saving works again
});

test("an old lock whose mtime is stale is taken over even though its pid is alive", () => {
  const dir = project();
  const { lockFile, root } = tandemLayout(dir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, at: new Date().toISOString(), token: "old" }));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(lockFile, old, old);
  const release = acquireLock(dir);
  assert.notEqual(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "old");
  release();
});

test("the heartbeat never leaves the lock unreadable (atomic rewrite), so a concurrent acquire always sees it held", async () => {
  const dir = project();
  const { lockFile } = tandemLayout(dir);
  const stateUrl = new URL("../scripts/lib/state.mjs", import.meta.url).href;
  const script = `import { acquireLock } from ${JSON.stringify(stateUrl)}; const release = acquireLock(process.argv[1]); setTimeout(() => { release(); }, 1500);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir], { stdio: "ignore", env: { ...process.env, TANDEM_LOCK_HEARTBEAT_MS: "2" } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  let unreadable = 0;
  let lockedRefusals = 0;
  const until = Date.now() + 1000;
  while (Date.now() < until) {
    try {
      JSON.parse(fs.readFileSync(lockFile, "utf8"));
    } catch {
      unreadable += 1;
    }
    try {
      acquireLock(dir)();
      break; // acquiring here would mean the held lock was treated as stale
    } catch (error) {
      if (error.code === "locked") lockedRefusals += 1;
      else throw error;
    }
  }
  await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(unreadable, 0, "lock file must always parse while held");
  assert.ok(lockedRefusals > 10, `expected many refusals, got ${lockedRefusals}`);
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
