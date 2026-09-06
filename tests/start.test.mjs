import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeProject, readLog, runTandem, startProject, writeFile } from "./helpers.mjs";

test("start creates .tandem, ledger, state with thread id and gitignore entry", () => {
  const dir = makeProject("start");
  fs.mkdirSync(path.join(dir, ".git"));
  const logFile = path.join(dir, "fake.log");
  const json = startProject(dir, { FAKE_CODEX_LOG: logFile, FAKE_THREAD_ID: "thread-start" });
  assert.equal(json.threadId, "thread-start");
  assert.equal(json.reply, "FAKE OK");
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8"));
  assert.equal(state.threadId, "thread-start");
  assert.equal(state.codexVersion, "9.9.9");
  assert.equal(state.usage.total.total, 120);
  assert.equal(state.rateLimits.primary.usedPercent, 18);
  assert.match(fs.readFileSync(path.join(dir, ".tandem", "ledger.md"), "utf8"), /Tandem-Ledger/);
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /\.tandem\//);
  const execCall = readLog(logFile).find((c) => c.argv[0] === "exec");
  assert.ok(execCall.stdin.includes("Testprojekt"));
  assert.ok(execCall.argv.includes("read-only"));
  assert.equal(execCall.argv[execCall.argv.indexOf("-C") + 1], dir);
});

test("start refuses to run twice without --force", () => {
  const dir = makeProject("twice");
  startProject(dir);
  const summary = path.join(dir, "summary.md");
  const again = runTandem(["start", "--summary-file", summary], { cwd: dir });
  assert.equal(again.json.error, "already_started");
  const forced = runTandem(["start", "--summary-file", summary, "--force"], { cwd: dir });
  assert.equal(forced.json.ok, true);
});

test("start requires an absolute summary file and reports codex failures", () => {
  const dir = makeProject("startfail");
  assert.equal(runTandem(["start", "--summary-file", "summary.md"], { cwd: dir }).json.error, "bad_path");
  const summary = writeFile(dir, "summary.md", "x");
  const failed = runTandem(["start", "--summary-file", summary], { cwd: dir, env: { FAKE_CODEX_MODE: "auth" } });
  assert.equal(failed.json.error, "auth");
  assert.equal(fs.existsSync(path.join(dir, ".tandem", "state.json")), false);
});

test("start is blocked by the rate-limit guard", () => {
  const dir = makeProject("startquota");
  const summary = writeFile(dir, "summary.md", "x");
  const blocked = runTandem(["start", "--summary-file", summary], { cwd: dir, env: { FAKE_USED_SECONDARY: "99" } });
  assert.equal(blocked.json.error, "quota_low");
});
