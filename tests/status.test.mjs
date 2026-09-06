import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { killTree } from "../scripts/lib/codex.mjs";
import { makeProject, runTandem, startProject, writeFile } from "./helpers.mjs";

const WORKER_BRIEF = ["## Auftragstyp", "Tests", "## Baseline", "x", "## Ziel", "x", "## Nicht-Ziele", "y", "## Erlaubte Dateien", "-", "## Schnittstellen", "-", "## Akzeptanztests", "-", "## Löschrechte", "-", "## Stop-Bedingungen", "-", "## Kontext aus dem Ledger", "-"].join("\n");

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

test("status refreshes workers and stop cancels the active ones", () => {
  const dir = makeProject("status-workers");
  startProject(dir);
  const zone = path.join(dir, "zone");
  fs.mkdirSync(zone);
  const brief = writeFile(dir, "brief.md", WORKER_BRIEF);
  const started = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  const status = runTandem(["status", "--human"], { cwd: dir });
  assert.equal(status.json.workers.length, 1);
  assert.equal(status.json.workers[0].status, "running");
  assert.equal(status.json.workers[0].usageBooked, undefined);
  assert.equal(status.json.activeWorkers, 1);
  assert.match(status.json.human, /Worker aktiv: 1/);
  const stopped = runTandem(["stop"], { cwd: dir });
  assert.equal(stopped.json.cancelledWorkers, 1);
  assert.equal(stopped.json.unresolvedWorkers, 0);
  assert.equal(runTandem(["status"], { cwd: dir }).json.workers[0].status, "cancelled");
});

test("stop reports workers whose kill could not be confirmed", () => {
  const dir = makeProject("status-killfail");
  startProject(dir);
  const zone = path.join(dir, "zone");
  fs.mkdirSync(zone);
  const brief = writeFile(dir, "brief.md", WORKER_BRIEF);
  const started = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  const stopped = runTandem(["stop"], { cwd: dir, env: { TANDEM_TEST_NO_KILL: "1" } });
  assert.equal(stopped.json.unresolvedWorkers, 1);
  assert.equal(stopped.json.stopped, true);
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8"));
  assert.equal(state.workers[0].status, "killing");
  killTree(started.json.worker.pid); // clean up the fake tree ourselves
});

test("the human status line counts active workers and pending retries separately and lists both", () => {
  const dir = makeProject("status-mixed");
  startProject(dir);
  const zone = path.join(dir, "zone");
  fs.mkdirSync(zone);
  const zone2 = path.join(dir, "zone2");
  fs.mkdirSync(zone2);
  const brief = writeFile(dir, "brief.md", [
    "## Auftragstyp", "Tests", "## Baseline", "frisch", "## Ziel", "x", "## Nicht-Ziele", "y", "## Erlaubte Dateien", "- ok.txt",
    "## Schnittstellen", "keine", "## Akzeptanztests", "- ok", "## Löschrechte", "keine", "## Stop-Bedingungen", "BLOCKED", "## Kontext aus dem Ledger", "keiner"
  ].join("\n"));
  // W1: invalid result whose retry the budget refuses -> retry_pending. W2: hanging -> running.
  // Budget queries in order: W1 start (ok), W1 retry (refused), W2's refresh retry (refused), W2 start (ok),
  // then every later refresh keeps refusing (the fake repeats the last value).
  const pendingEnv = { FAKE_CODEX_LOG: path.join(dir, "fake.log"), FAKE_WORKER_INVALID: "1", FAKE_USED_PRIMARY_SEQUENCE: "18,97,97,18,97" };
  assert.equal(runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: pendingEnv }).json.ok, true);
  assert.equal(runTandem(["worker", "wait", "W1", "--poll-sec", "1"], { cwd: dir, env: pendingEnv }).json.worker.status, "retry_pending");
  const hang = runTandem(["worker", "start", "--zone", zone2, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { ...pendingEnv, FAKE_CODEX_MODE: "hang" } });
  assert.equal(hang.json.ok, true, JSON.stringify(hang.json));
  const status = runTandem(["status", "--human"], { cwd: dir, env: pendingEnv });
  assert.equal(status.json.activeWorkers, 1);
  assert.equal(status.json.pendingRetries, 1);
  assert.match(status.json.human, /Worker aktiv: 1 · ausstehende Retries: 1 \(W1 retry_pending [^,]+, W2 running /);
  runTandem(["worker", "cancel", "W2"], { cwd: dir, env: pendingEnv });
});
