import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { killTree, parseJsonl } from "../scripts/lib/codex.mjs";
import { sleepSync } from "../scripts/lib/procs.mjs";
import { makeProject, readLog, runTandem, startProject, writeFile } from "./helpers.mjs";

const BRIEF = [
  "# Auftrag W",
  "## Auftragstyp", "Tests — warum Codex: abgegrenzt und in der Zone testbar.",
  "## Baseline", "frisch",
  "## Ziel", "Schreibe ok.txt mit dem Inhalt ok.",
  "## Nicht-Ziele", "Nichts anderes anfassen.",
  "## Erlaubte Dateien", "- ok.txt",
  "## Schnittstellen", "keine",
  "## Akzeptanztests", "- Datei existiert",
  "## Löschrechte", "keine",
  "## Stop-Bedingungen", "Bei Unklarheit BLOCKED.",
  "## Kontext aus dem Ledger", "keiner"
].join("\n");

function prepared(name) {
  const dir = makeProject(name);
  startProject(dir);
  const zone = path.join(dir, "zone");
  fs.mkdirSync(zone);
  const brief = writeFile(dir, "brief.md", BRIEF);
  return { dir, zone, brief, logFile: path.join(dir, "fake.log") };
}

function stateOf(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8"));
}

test("worker start validates brief and zone, spawns detached; wait returns DONE with usage booked", () => {
  const { dir, zone, brief, logFile } = prepared("worker-ok");
  const incomplete = writeFile(dir, "short.md", "## Ziel\nx\n## Nicht-Ziele\ny\n");
  const short = runTandem(["worker", "start", "--zone", zone, "--brief-file", incomplete], { cwd: dir });
  assert.equal(short.json.error, "brief_incomplete");
  assert.match(short.json.message, /Auftragstyp/);
  assert.equal(runTandem(["worker", "start", "--zone", path.join(dir, "missing"), "--brief-file", brief], { cwd: dir }).json.error, "bad_zone");
  // The fake lingers briefly so the process is still alive while its identity (start time) is captured.
  const started = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_CODEX_LOG: logFile, FAKE_WORKER_WRITE: "1", FAKE_WORKER_LINGER_MS: "2500" } });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  assert.equal(started.json.worker.id, "W1");
  assert.equal(started.json.worker.status, "running");
  assert.ok(Number.isFinite(started.json.worker.procStart), "identity captured at spawn");
  assert.equal(started.json.worker.identityPending, false);
  assert.equal(started.json.activeWorkers, 1);
  const waited = runTandem(["worker", "wait", "W1", "--poll-sec", "1"], { cwd: dir });
  assert.equal(waited.json.worker.status, "done", JSON.stringify(waited.json));
  assert.equal(waited.json.worker.result.status, "DONE");
  assert.equal(fs.readFileSync(path.join(zone, "ok.txt"), "utf8"), "ok");
  const call = readLog(logFile).find((c) => c.argv[0] === "exec");
  assert.ok(call.argv.includes("workspace-write"));
  assert.equal(call.argv[call.argv.indexOf("-C") + 1].toLowerCase(), fs.realpathSync.native(zone).toLowerCase());
  assert.ok(call.argv.includes("--output-schema"));
  assert.ok(call.stdin.includes("## Ziel"));
  assert.ok(call.stdin.includes("Tandem-Worker-Vertrag (W1"));
  assert.ok(call.stdin.toLowerCase().includes(fs.realpathSync.native(dir).toLowerCase()), "contract names the canonical project path");
  const state = stateOf(dir);
  assert.equal(state.usage.byKind.worker.runs, 1);
  assert.equal(state.usage.byKind.worker.total, 120);
  assert.equal(state.workers[0].status, "done");
  assert.ok(fs.existsSync(path.join(dir, ".tandem", "workers", "W1", "brief.md")));
  assert.ok(fs.existsSync(path.join(dir, ".tandem", "workers", "W1", "log.txt")));
});

test("PARTIAL and BLOCKED results are reported; a hanging worker times out and is killed", () => {
  const { dir, zone, brief } = prepared("worker-states");
  const w1 = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_WORKER_STATUS: "BLOCKED" } });
  const blocked = runTandem(["worker", "wait", w1.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  assert.equal(blocked.json.worker.status, "blocked");
  assert.equal(blocked.json.worker.result.blockers[0].text, "fake blocker");
  const zone2 = path.join(dir, "zone2");
  fs.mkdirSync(zone2);
  const w2 = runTandem(["worker", "start", "--zone", zone2, "--brief-file", brief], { cwd: dir, env: { FAKE_WORKER_STATUS: "PARTIAL" } });
  assert.equal(runTandem(["worker", "wait", w2.json.worker.id, "--poll-sec", "1"], { cwd: dir }).json.worker.status, "partial");
  const zone3 = path.join(dir, "zone3");
  fs.mkdirSync(zone3);
  const w3 = runTandem(["worker", "start", "--zone", zone3, "--brief-file", brief, "--deadline-min", "0.05"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(w3.json.ok, true, JSON.stringify(w3.json));
  const waited = runTandem(["worker", "wait", w3.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  assert.equal(waited.json.worker.status, "timeout");
  assert.equal(waited.json.worker.killReason, "timeout");
});

test("a result with a still-running process is 'finishing' and keeps the zone reserved until exit", () => {
  const { dir, zone, brief } = prepared("worker-linger");
  const started = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_WORKER_LINGER_MS: "4000" } });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  sleepSync(1500);
  const mid = runTandem(["worker", "status", "W1"], { cwd: dir });
  assert.equal(mid.json.workers[0].status, "finishing", JSON.stringify(mid.json));
  assert.equal(mid.json.active, 1);
  assert.equal(stateOf(dir).usage.byKind.worker, undefined, "usage is booked only after exit");
  assert.equal(runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir }).json.error, "bad_zone", "zone still reserved");
  const waited = runTandem(["worker", "wait", "W1", "--poll-sec", "1"], { cwd: dir });
  assert.equal(waited.json.worker.status, "done");
  assert.equal(stateOf(dir).usage.byKind.worker.runs, 1);
});

test("an invalid result is retried exactly once by resuming the worker thread (read-only, budget-checked)", () => {
  const { dir, zone, brief, logFile } = prepared("worker-retry");
  const onceFlag = path.join(dir, "invalid-once.flag");
  const w1 = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_CODEX_LOG: logFile, FAKE_WORKER_INVALID_ONCE: onceFlag, FAKE_THREAD_ID: "worker-thread" } });
  const waited = runTandem(["worker", "wait", w1.json.worker.id, "--poll-sec", "1"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile, FAKE_WORKER_INVALID_ONCE: onceFlag } });
  assert.equal(waited.json.worker.status, "done", JSON.stringify(waited.json));
  assert.equal(waited.json.worker.retried, true);
  const calls = readLog(logFile);
  const resume = calls.find((c) => c.argv[1] === "resume");
  assert.equal(resume.argv[2], "worker-thread");
  assert.ok(resume.argv.includes("sandbox_mode=read-only"));
  assert.ok(resume.stdin.includes("nicht schema-konform"));
  assert.ok(calls.some((c) => c.argv[0] === "app-server"), "budget checked before the retry");
  assert.equal(stateOf(dir).usage.byKind.worker.runs, 2);
  const zone2 = path.join(dir, "zone2");
  fs.mkdirSync(zone2);
  const w2 = runTandem(["worker", "start", "--zone", zone2, "--brief-file", brief], { cwd: dir, env: { FAKE_WORKER_INVALID: "1" } });
  const still = runTandem(["worker", "wait", w2.json.worker.id, "--poll-sec", "1"], { cwd: dir, env: { FAKE_WORKER_INVALID: "1" } });
  assert.equal(still.json.worker.status, "invalid_output");
  assert.equal(still.json.worker.retried, true);
});

test("a budget refusal before the retry leaves it pending (not consumed); a quota failure of the retry pauses tandem", () => {
  const { dir, zone, brief, logFile } = prepared("worker-retry-budget");
  const onceFlag = path.join(dir, "invalid-once.flag");
  // Budget queries in order: start (18 % → ok), first retry attempt (97 % → refused, pending), second attempt (18 % → ok).
  const env = { FAKE_CODEX_LOG: logFile, FAKE_WORKER_INVALID_ONCE: onceFlag, FAKE_USED_PRIMARY_SEQUENCE: "18,97,18" };
  const w1 = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env });
  const pending = runTandem(["worker", "wait", w1.json.worker.id, "--poll-sec", "1"], { cwd: dir, env });
  assert.equal(pending.json.worker.status, "retry_pending", JSON.stringify(pending.json));
  assert.notEqual(pending.json.worker.retried, true, "a refused retry is not consumed");
  assert.equal(readLog(logFile).filter((c) => c.argv[1] === "resume").length, 0, "no model call while the budget refuses");
  assert.equal(runTandem(["worker", "status"], { cwd: dir, env: { ...env, FAKE_USED_PRIMARY_SEQUENCE: "18,97,97" } }).json.active, 0, "zone is free while pending");
  const done = runTandem(["worker", "status", w1.json.worker.id], { cwd: dir, env });
  assert.equal(done.json.workers[0].status, "done", JSON.stringify(done.json));
  assert.equal(done.json.workers[0].retried, true);
  assert.equal(readLog(logFile).filter((c) => c.argv[1] === "resume").length, 1);
  const zone2 = path.join(dir, "zone2");
  fs.mkdirSync(zone2);
  const w2 = runTandem(["worker", "start", "--zone", zone2, "--brief-file", brief], { cwd: dir, env: { FAKE_WORKER_INVALID: "1" } });
  const failed = runTandem(["worker", "wait", w2.json.worker.id, "--poll-sec", "1"], { cwd: dir, env: { FAKE_WORKER_INVALID: "1", FAKE_CODEX_MODE: "quota" } });
  assert.equal(failed.json.worker.status, "failed");
  assert.equal(failed.json.worker.failure, "quota");
  assert.equal(stateOf(dir).paused, true, "the retry's quota failure pauses tandem like any other call");
});

test("max two active workers, overlapping zones rejected, cancel verifies the kill, status counts", () => {
  const { dir, zone, brief } = prepared("worker-limit");
  const zoneB = path.join(dir, "zoneB");
  fs.mkdirSync(zoneB);
  const zoneC = path.join(dir, "zoneC");
  fs.mkdirSync(zoneC);
  const a = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  const b = runTandem(["worker", "start", "--zone", zoneB, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(a.json.ok, true);
  assert.equal(b.json.ok, true);
  assert.equal(runTandem(["worker", "start", "--zone", zoneC, "--brief-file", brief], { cwd: dir }).json.error, "too_many_workers");
  const cancelled = runTandem(["worker", "cancel", a.json.worker.id], { cwd: dir });
  assert.equal(cancelled.json.worker.status, "cancelled");
  assert.equal(cancelled.json.gone, true);
  const nested = path.join(zoneB, "inner");
  fs.mkdirSync(nested);
  assert.equal(runTandem(["worker", "start", "--zone", nested, "--brief-file", brief], { cwd: dir }).json.error, "bad_zone");
  runTandem(["worker", "cancel", b.json.worker.id], { cwd: dir });
  const status = runTandem(["worker", "status"], { cwd: dir });
  assert.equal(status.json.active, 0);
  assert.equal(status.json.workers.length, 2);
  assert.equal(runTandem(["worker", "status", "W9"], { cwd: dir }).json.error, "no_such_worker");
  assert.equal(runTandem(["worker", "dance"], { cwd: dir }).json.error, "bad_subcommand");
});

test("a failed kill keeps the worker active as 'killing' and the zone reserved; a recycled pid is never killed", () => {
  const { dir, zone, brief } = prepared("worker-kill");
  const a = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(a.json.ok, true);
  const failed = runTandem(["worker", "cancel", "W1"], { cwd: dir, env: { TANDEM_TEST_NO_KILL: "1" } });
  assert.equal(failed.json.worker.status, "killing");
  assert.equal(failed.json.worker.killFailed, true);
  assert.equal(failed.json.gone, false);
  assert.equal(runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir }).json.error, "bad_zone", "zone stays reserved while killing");
  const state = stateOf(dir);
  // Simulate a recycled pid: the recorded identity no longer matches the live process → tandem must treat
  // its worker as gone and must NOT kill the live process.
  state.workers[0].procStart = (state.workers[0].procStart ?? Date.now()) - 60 * 60 * 1000;
  fs.writeFileSync(path.join(dir, ".tandem", "state.json"), JSON.stringify(state, null, 2));
  const after = runTandem(["worker", "status", "W1"], { cwd: dir });
  assert.equal(after.json.workers[0].status, "cancelled", "our worker counts as gone");
  assert.equal(after.json.active, 0);
  const pid = state.workers[0].pid;
  assert.equal(Number.isFinite(pid), true);
  killTree(pid); // clean up the (still running) fake tree ourselves
});

test("worker paths are passed verbatim (no shell): a %VAR%-looking zone name stays literal", () => {
  const { dir, brief, logFile } = prepared("worker-percent");
  const zone = path.join(dir, "z%USERNAME%z");
  fs.mkdirSync(zone);
  const started = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_CODEX_LOG: logFile, FAKE_WORKER_WRITE: "1" } });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  const waited = runTandem(["worker", "wait", started.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  assert.equal(waited.json.worker.status, "done");
  const call = readLog(logFile).find((c) => c.argv[0] === "exec");
  assert.equal(call.argv[call.argv.indexOf("-C") + 1].toLowerCase(), fs.realpathSync.native(zone).toLowerCase(), "the zone reached codex unexpanded");
  assert.ok(fs.existsSync(path.join(zone, "ok.txt")), "the worker wrote into the literal zone");
});

test("a pending retry rests while paused and is cancelled by stop (no model call either way)", () => {
  const { dir, zone, brief, logFile } = prepared("worker-retry-paused");
  const onceFlag = path.join(dir, "invalid-once.flag");
  const env = { FAKE_CODEX_LOG: logFile, FAKE_WORKER_INVALID_ONCE: onceFlag, FAKE_USED_PRIMARY_SEQUENCE: "18,97,18,18" };
  const w1 = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env });
  assert.equal(runTandem(["worker", "wait", w1.json.worker.id, "--poll-sec", "1"], { cwd: dir, env }).json.worker.status, "retry_pending");
  runTandem(["pause"], { cwd: dir });
  assert.equal(runTandem(["status"], { cwd: dir, env }).json.workers[0].status, "retry_pending", "paused: the retry must rest");
  assert.equal(runTandem(["worker", "status"], { cwd: dir, env }).json.workers[0].status, "retry_pending");
  assert.equal(readLog(logFile).filter((c) => c.argv[1] === "resume").length, 0, "no model call while paused");
  const stopped = runTandem(["stop"], { cwd: dir, env });
  assert.equal(stopped.json.cancelledWorkers, 1);
  assert.equal(runTandem(["status"], { cwd: dir, env }).json.workers[0].status, "cancelled");
  assert.equal(readLog(logFile).filter((c) => c.argv[1] === "resume").length, 0, "stop never triggers the retry");
});

test("a worker without a captured identity is never killed and its identity is never filled in later", () => {
  const { dir, zone, brief } = prepared("worker-identity");
  const a = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(a.json.ok, true);
  const state = stateOf(dir);
  state.workers[0].procStart = null; // as if Get-Process/ps had failed at spawn
  fs.writeFileSync(path.join(dir, ".tandem", "state.json"), JSON.stringify(state, null, 2));
  const cancelled = runTandem(["worker", "cancel", "W1"], { cwd: dir });
  assert.equal(cancelled.json.gone, false);
  assert.equal(cancelled.json.worker.status, "killing");
  assert.equal(cancelled.json.worker.killBlockedBy, "identity_unknown");
  const status = runTandem(["worker", "status", "W1"], { cwd: dir });
  assert.equal(status.json.workers[0].procStart, null, "identity is never adopted from the current pid owner");
  assert.equal(status.json.workers[0].identityUnknown, true);
  assert.equal(status.json.active, 1, "zone stays reserved");
  killTree(state.workers[0].pid); // clean up ourselves
  sleepSync(500);
  assert.equal(runTandem(["worker", "status", "W1"], { cwd: dir }).json.workers[0].status, "cancelled", "terminal once the process is gone");
});

test("worker start is blocked by the budget guard and by stop; --model is validated and passed through", () => {
  const { dir, zone, brief, logFile } = prepared("worker-guard");
  assert.equal(runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_USED_PRIMARY: "97" } }).json.error, "quota_low");
  assert.equal(runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--model", "bad model;x"], { cwd: dir }).json.error, "bad_model");
  const started = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--model", "gpt-5.3-codex-spark"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  assert.equal(started.json.worker.model, "gpt-5.3-codex-spark");
  runTandem(["worker", "wait", started.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  const call = readLog(logFile).find((c) => c.argv[0] === "exec");
  assert.equal(call.argv[call.argv.indexOf("-m") + 1], "gpt-5.3-codex-spark");
  runTandem(["stop"], { cwd: dir });
  assert.equal(runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir }).json.error, "stopped");
});

test("a worker that dies with a quota error pauses tandem", () => {
  const { dir, zone, brief } = prepared("worker-quota");
  const w = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_CODEX_MODE: "quota" } });
  assert.equal(w.json.ok, true);
  const waited = runTandem(["worker", "wait", w.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  assert.equal(waited.json.worker.status, "failed");
  assert.equal(waited.json.worker.failure, "quota");
  assert.equal(stateOf(dir).paused, true);
});

test("a codex that exits without writing the result file is settled from the final message in its log", () => {
  const { dir, zone, brief } = prepared("worker-no-result");
  // Codex writes -o only after its internal shutdown; a codex dying there leaves the report in the log only.
  const started = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_WORKER_NO_RESULT: "1", FAKE_WORKER_WRITE: "1" } });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  const waited = runTandem(["worker", "wait", "W1", "--poll-sec", "1"], { cwd: dir });
  assert.equal(waited.json.worker.status, "done", JSON.stringify(waited.json));
  assert.equal(waited.json.worker.result.status, "DONE");
  assert.equal(waited.json.worker.resultSource, "log");
  assert.equal(waited.json.worker.exitCode, 0);
  assert.equal(waited.json.worker.retried, undefined, "no retry call: the log already holds a valid report");
  assert.equal(fs.existsSync(path.join(dir, ".tandem", "workers", "W1", "result.json")), false);
  const events = parseJsonl(fs.readFileSync(path.join(dir, ".tandem", "workers", "W1", "log.txt"), "utf8"));
  assert.equal(events.at(-1).type, "tandem.exit", "the launcher appends the exit record last");
  assert.equal(stateOf(dir).usage.byKind.worker.runs, 1);
  const zone2 = path.join(dir, "zone2");
  fs.mkdirSync(zone2);
  const normal = runTandem(["worker", "start", "--zone", zone2, "--brief-file", brief], { cwd: dir });
  const done = runTandem(["worker", "wait", normal.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  assert.equal(done.json.worker.resultSource, "file");
  assert.equal(done.json.worker.exitCode, 0);
});

test("a worker that dies without any report is orphaned with its exit code; a non-zero exit with a valid report still counts", () => {
  const { dir, zone, brief } = prepared("worker-exit-codes");
  const crashed = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_CODEX_MODE: "fail" } });
  assert.equal(crashed.json.ok, true, JSON.stringify(crashed.json));
  const waited = runTandem(["worker", "wait", crashed.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  assert.equal(waited.json.worker.status, "orphaned", JSON.stringify(waited.json));
  assert.equal(waited.json.worker.failure, "codex_failed");
  assert.equal(waited.json.worker.exitCode, 2);
  assert.equal(waited.json.worker.exitSignal, null);
  assert.equal(stateOf(dir).paused, false, "an unclassified crash does not pause tandem");
  const zone2 = path.join(dir, "zone2");
  fs.mkdirSync(zone2);
  const odd = runTandem(["worker", "start", "--zone", zone2, "--brief-file", brief], { cwd: dir, env: { FAKE_WORKER_EXIT_CODE: "3" } });
  const settled = runTandem(["worker", "wait", odd.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  assert.equal(settled.json.worker.status, "done", "a valid report wins over the exit code");
  assert.equal(settled.json.worker.exitCode, 3);
  assert.equal(settled.json.worker.resultSource, "file");
});

test("a failing start-time query never declares a live worker gone and never lets it be killed", () => {
  const { dir, zone, brief } = prepared("worker-hiccup");
  const a = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(a.json.ok, true, JSON.stringify(a.json));
  assert.ok(Number.isFinite(a.json.worker.procStart));
  const hiccup = { TANDEM_TEST_START_TIME_FAIL: "1" }; // PowerShell/ps does not answer right now
  const status = runTandem(["worker", "status", "W1"], { cwd: dir, env: hiccup });
  assert.equal(status.json.workers[0].status, "running", "still running, not orphaned");
  assert.equal(status.json.active, 1, "zone stays reserved");
  const cancelled = runTandem(["worker", "cancel", "W1"], { cwd: dir, env: hiccup });
  assert.equal(cancelled.json.gone, false);
  assert.equal(cancelled.json.worker.status, "killing");
  assert.equal(cancelled.json.worker.killBlockedBy, "identity_unverified");
  const state = stateOf(dir);
  assert.equal(state.workers[0].procStart, a.json.worker.procStart, "the recorded identity is untouched");
  const again = runTandem(["worker", "cancel", "W1"], { cwd: dir }); // the query works again: verified, killed
  assert.equal(again.json.gone, true, JSON.stringify(again.json));
  assert.equal(again.json.worker.status, "cancelled");
  assert.equal(runTandem(["worker", "status"], { cwd: dir }).json.active, 0);
});
