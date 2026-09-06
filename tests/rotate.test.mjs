import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeProject, readLog, runTandem, startProject, writeFile } from "./helpers.mjs";

test("rotate starts a new thread seeded from the ledger summary and archives the old one", () => {
  const dir = makeProject("rotate");
  startProject(dir, { FAKE_THREAD_ID: "thread-old" });
  const logFile = path.join(dir, "fake.log");
  const seed = writeFile(dir, "seed.md", "Stand: Feature X halb fertig. Offen: Einwand C3-1.");
  runTandem(["stop"], { cwd: dir });
  const { json } = runTandem(["rotate", "--seed-file", seed, "--reason", "thread_lost"], { cwd: dir, env: { FAKE_THREAD_ID: "thread-new", FAKE_CODEX_LOG: logFile } });
  assert.equal(json.ok, true);
  assert.equal(json.threadId, "thread-new");
  assert.equal(json.previousThreadId, "thread-old");
  const call = readLog(logFile).find((c) => c.argv[0] === "exec");
  assert.ok(call.stdin.includes("Fortsetzung eines früheren Tandem-Threads"));
  assert.ok(call.stdin.includes("Einwand C3-1"));
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8"));
  assert.equal(state.threadId, "thread-new");
  assert.equal(state.threadHistory[0].threadId, "thread-old");
  assert.equal(state.threadHistory[0].reason, "thread_lost");
  assert.equal(state.stopped, false);
  assert.equal(state.contacts, 1);
});
