#!/usr/bin/env node
// Detached worker launcher. The runner never waits for a worker (each runner call is short-lived), so the
// exit code of codex would be lost. This wrapper runs codex with INHERITED stdio (stdin = the brief file,
// stdout/stderr = the log file, both opened by the runner) and appends exactly one JSON line
// {"type":"tandem.exit","code":…,"signal":…} to the log when codex has exited. No shell is involved.
//
// Two guarantees for the zone:
// - Before anything write-capable exists it writes launched.json (its own pid) next to the log, so a worker
//   whose runner died between reserving the record and saving the pid can still be found. If the marker
//   cannot be written, nothing is started (exit 65).
// - Descendants never outlive the worker: on Windows codex runs inside a Job Object with kill-on-close
//   (win-job-run.ps1), on POSIX the launcher kills its own process group when codex ends (the runner spawns
//   it as a group leader and sets TANDEM_LAUNCH_GROUP=1). A worker is reported finished only after that.
// Usage: node worker-launch.mjs <absolute logFile> <cmd> [args...]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JOB_SCRIPT = fileURLToPath(new URL("./win-job-run.ps1", import.meta.url));
const [logFile, cmd, ...args] = process.argv.slice(2);
if (!logFile || !cmd) {
  process.stderr.write("usage: worker-launch.mjs <logFile> <cmd> [args...]\n");
  process.exit(64);
}
const markerFile = path.join(path.dirname(logFile), "launched.json");

function record(entry) {
  try {
    // Leading newline: if codex died in the middle of a line, the exit record must still start a line.
    fs.appendFileSync(logFile, `\n${JSON.stringify({ type: "tandem.exit", at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // the log is gone; there is nobody left to report to
  }
}

// Fail-closed: without the marker a runner crash could leave an unregistered write-capable process.
function mark(extra = {}) {
  fs.writeFileSync(markerFile, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...extra })}\n`, "utf8");
}

// POSIX: take every remaining member of the launcher's process group along (codex and all its descendants
// inherit the group unless they start their own session). Only when the runner made us a group leader.
function reapGroup() {
  if (process.platform === "win32" || process.env.TANDEM_LAUNCH_GROUP !== "1") return;
  try {
    process.kill(-process.pid, "SIGKILL"); // includes ourselves: the exit record is already written
  } catch {
    // group already empty
  }
}

function leave(entry, code) {
  record(entry);
  reapGroup();
  process.exit(code);
}

try {
  mark();
} catch (error) {
  record({ code: 65, signal: null, error: `launch marker not writable: ${error.message}` });
  process.exit(65);
}

// The job wrapper gets the command line as a JSON file (PowerShell's own argument parser rejects a bare "-"
// and reinterprets others); the file also documents exactly what was started.
const useJob = process.platform === "win32" && process.env.TANDEM_TEST_NO_JOB !== "1";
let spawnCmd = cmd;
let spawnArgs = args;
if (useJob) {
  const cmdFile = path.join(path.dirname(logFile), "launch-cmd.json");
  try {
    fs.writeFileSync(cmdFile, JSON.stringify([cmd, ...args]), "utf8");
  } catch (error) {
    leave({ code: 65, signal: null, error: `launch command file not writable: ${error.message}` }, 65);
  }
  spawnCmd = "powershell.exe";
  spawnArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", JOB_SCRIPT, cmdFile];
}
let child;
try {
  child = spawn(spawnCmd, spawnArgs, { stdio: "inherit", windowsHide: true });
} catch (error) {
  leave({ code: 127, signal: null, error: error.message }, 127);
}
try {
  mark({ childPid: child.pid ?? null, job: useJob });
} catch {
  // the first marker is in place; the child pid is a convenience
}

let reported = false;
child.on("error", (error) => {
  if (reported) return;
  reported = true;
  leave({ code: 127, signal: null, error: error.message }, 127);
});
child.on("exit", (code, signal) => {
  if (reported) return;
  reported = true;
  if (useJob && code === 66) leave({ code: 66, signal: null, error: "job wrapper failed (see tandem-job-error in the log)" }, 66);
  else leave({ code, signal }, code ?? 1);
});

// If someone terminates the launcher alone (POSIX signals), take codex along instead of orphaning it.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  try {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    });
  } catch {
    // signal not supported on this platform
  }
}
