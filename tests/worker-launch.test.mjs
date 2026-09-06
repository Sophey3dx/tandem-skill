import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseJsonl } from "../scripts/lib/codex.mjs";
import { pidAlive } from "../scripts/lib/state.mjs";
import { sleepSync } from "../scripts/lib/procs.mjs";
import { makeProject } from "./helpers.mjs";

const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lib", "worker-launch.mjs");

function launch(logFile, cmd, args, { stdinText = "", env = {} } = {}) {
  const stdinFile = path.join(path.dirname(logFile), "stdin.txt");
  fs.writeFileSync(stdinFile, stdinText, "utf8");
  const inFd = fs.openSync(stdinFile, "r");
  const outFd = fs.openSync(logFile, "a");
  try {
    return spawnSync(process.execPath, [LAUNCHER, logFile, cmd, ...args], { stdio: [inFd, outFd, outFd], encoding: "utf8", timeout: 60000, env: { ...process.env, ...env } });
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
}

function exitRecord(logFile) {
  return parseJsonl(fs.readFileSync(logFile, "utf8")).find((e) => e.type === "tandem.exit");
}

test("the launcher passes stdio through, writes launched.json and appends the child's exit code to the log", () => {
  const dir = makeProject("launch");
  const logFile = path.join(dir, "log.txt");
  // With `node -e`, process.argv[1] is already the first extra argument.
  const script = "process.stdout.write(require('fs').readFileSync(0,'utf8').toUpperCase() + ' ' + JSON.stringify(process.argv.slice(1)) + '\\n'); process.stderr.write('err-line\\n'); process.exit(5)";
  const result = launch(logFile, process.execPath, ["-e", script, "a b", "q\"uote", "back\\slash\\", "%PATH%", "-"], { stdinText: "brief text" });
  assert.equal(result.status, 5, "the launcher exits with the child's code");
  const text = fs.readFileSync(logFile, "utf8");
  assert.match(text, /^BRIEF TEXT \["a b","q\\"uote","back\\\\slash\\\\","%PATH%","-"\]\r?\n/, "stdin reached the child, arguments (incl. a bare dash) arrived verbatim, stdout reached the log");
  assert.match(text, /err-line/, "stderr reached the log");
  const exit = exitRecord(logFile);
  assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 5, signal: null });
  assert.ok(Date.parse(exit.at) > 0);
  const marker = JSON.parse(fs.readFileSync(path.join(dir, "launched.json"), "utf8"));
  assert.equal(marker.pid, result.pid, "launched.json names the launcher itself");
  assert.ok(Number.isInteger(marker.childPid), "and the child it started");
  assert.equal(marker.job, process.platform === "win32");
});

test("no descendant outlives the worker: a grandchild orphaned by its parent is killed when the child exits", async () => {
  const dir = makeProject("launch-tree");
  const logFile = path.join(dir, "log.txt");
  const late = path.join(dir, "late.txt");
  // Windows: even a detached grandchild dies with the Job Object. POSIX without a systemd scope (this test runs
  // the launcher with the default confinement of the platform): the process group covers a grandchild that
  // stays in the group; a setsid escapee is only covered by the systemd scope the runner uses on Linux.
  const detached = process.platform === "win32";
  const probe = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync(" + JSON.stringify(${JSON.stringify(late)}) + ", 'late'), 3000)"], { detached: ${detached}, stdio: "ignore", windowsHide: true }); g.unref(); process.stdout.write("grandchild " + g.pid + "\\n"); process.exit(0)`;
  // detached + TANDEM_LAUNCH_GROUP mirror how the runner starts the launcher (POSIX group leader).
  const stdinFile = path.join(dir, "stdin.txt");
  fs.writeFileSync(stdinFile, "", "utf8");
  const inFd = fs.openSync(stdinFile, "r");
  const outFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [LAUNCHER, logFile, process.execPath, "-e", probe], { stdio: [inFd, outFd, outFd], detached: true, windowsHide: true, env: { ...process.env, TANDEM_LAUNCH_GROUP: "1" } });
  fs.closeSync(inFd);
  fs.closeSync(outFd);
  await new Promise((resolve) => child.on("exit", resolve));
  const grandchild = Number(/grandchild (\d+)/.exec(fs.readFileSync(logFile, "utf8"))?.[1]);
  assert.ok(Number.isInteger(grandchild), "the child reported its grandchild");
  sleepSync(4500);
  assert.equal(fs.existsSync(late), false, "the grandchild must not get to write after the worker ended");
  assert.equal(pidAlive(grandchild), false, "the grandchild is dead");
  assert.equal(exitRecord(logFile).code, 0);
});

test("without a writable launch marker nothing is started (fail-closed, exit 65)", () => {
  const dir = makeProject("launch-marker");
  const logFile = path.join(dir, "log.txt");
  fs.mkdirSync(path.join(dir, "launched.json")); // a directory where the marker file must go
  const witness = path.join(dir, "started.txt");
  const result = launch(logFile, process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(witness)}, 'started')`]);
  assert.equal(result.status, 65);
  assert.equal(fs.existsSync(witness), false, "the child never ran");
  const exit = exitRecord(logFile);
  assert.equal(exit.code, 65);
  assert.match(exit.error, /launch marker not writable/);
});

test("a launcher that finds the record abandoned by the runner does not start (exclusive marker)", () => {
  const dir = makeProject("launch-abandoned");
  const logFile = path.join(dir, "log.txt");
  fs.writeFileSync(path.join(dir, "launched.json"), JSON.stringify({ abandoned: true, at: new Date().toISOString() }), "utf8");
  const witness = path.join(dir, "started.txt");
  const result = launch(logFile, process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(witness)}, 'started')`]);
  assert.equal(result.status, 65);
  assert.equal(fs.existsSync(witness), false, "a late launcher never starts codex into a zone that is free again");
  assert.match(exitRecord(logFile).error, /abandoned by the runner/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "launched.json"), "utf8")).abandoned, true, "the runner's marker is untouched");
});

test("the launcher reports a command that cannot be started (no shell, no throw) as exit 127", () => {
  const dir = makeProject("launch-missing");
  const logFile = path.join(dir, "log.txt");
  // Without the job wrapper the spawn error surfaces directly; with it the wrapper reports a failed start.
  const result = launch(logFile, path.join(dir, "missing-codex.exe"), ["exec"], { env: { TANDEM_CONFINEMENT: "none" } });
  assert.equal(result.status, 127);
  const exit = exitRecord(logFile);
  assert.equal(exit.code, 127);
  assert.match(exit.error, /ENOENT/);
  assert.ok(fs.existsSync(path.join(dir, "launched.json")), "the marker is written before the spawn attempt");
});

test("a job wrapper that cannot start the command reports exit 66 with an error", { skip: process.platform !== "win32" }, () => {
  const dir = makeProject("launch-job-fail");
  const logFile = path.join(dir, "log.txt");
  const result = launch(logFile, path.join(dir, "missing-codex.exe"), ["exec"]);
  assert.equal(result.status, 66);
  const exit = exitRecord(logFile);
  assert.equal(exit.code, 66);
  assert.match(exit.error, /job wrapper failed/);
  assert.match(fs.readFileSync(logFile, "utf8"), /tandem-job-error: CreateProcess failed/);
});

test("the launcher refuses to run without a log file and a command", () => {
  const result = spawnSync(process.execPath, [LAUNCHER], { encoding: "utf8" });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage/);
});
