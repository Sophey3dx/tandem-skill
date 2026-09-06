#!/usr/bin/env node
// Detached worker launcher. The runner never waits for a worker (each runner call is short-lived), so the
// exit code of codex would be lost. This wrapper runs codex with INHERITED stdio (stdin = the brief file,
// stdout/stderr = the log file, both opened by the runner) and appends exactly one JSON line
// {"type":"tandem.exit","code":…,"signal":…} to the log when codex has exited. No shell is involved.
//
// Guarantees for the zone:
// - Before anything write-capable exists it creates launched.json (its own pid) next to the log, EXCLUSIVELY
//   ("wx"). A worker whose runner died between reserving the record and saving the pid is found through it.
//   If the file cannot be created, nothing is started (exit 65): either the marker is unwritable, or the
//   runner already gave the record up and left an "abandoned" marker under the same name, so a late launcher
//   must not start codex into a zone that is free again.
// - Descendants do not outlive the worker: on Windows codex runs inside a Job Object with kill-on-close
//   (win-job-run.ps1), which covers every descendant however detached. On POSIX the launcher kills every
//   process whose parent chain still leads to it and then its own process group (the runner spawns it as a
//   group leader and sets TANDEM_LAUNCH_GROUP=1); a descendant that started its own session (setsid) is not
//   covered there, which the documentation states.
// Usage: node worker-launch.mjs <absolute logFile> <cmd> [args...]
import { spawn, spawnSync } from "node:child_process";
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

// Fail-closed and exclusive: the first write creates the marker ("wx"); later writes update our own file.
function mark(extra = {}, { exclusive = false } = {}) {
  fs.writeFileSync(markerFile, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...extra })}\n`, { encoding: "utf8", flag: exclusive ? "wx" : "w" });
}

// POSIX: kill every process whose parent chain still leads to us, then the whole process group (which also
// covers children reparented to init while their parent lived in our group). Windows: the Job Object did it.
function reapDescendants() {
  if (process.platform === "win32") return;
  try {
    const listing = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).stdout ?? "";
    const childrenOf = new Map();
    for (const line of listing.split("\n")) {
      const fields = line.trim().split(/\s+/).map(Number);
      if (fields.length !== 2 || !fields.every(Number.isInteger)) continue;
      const [pid, ppid] = fields;
      if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
      childrenOf.get(ppid).push(pid);
    }
    const stack = [process.pid];
    const descendants = [];
    while (stack.length > 0) {
      for (const pid of childrenOf.get(stack.pop()) ?? []) {
        descendants.push(pid);
        stack.push(pid);
      }
    }
    for (const pid of descendants) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  } catch {
    // ps unavailable: the group kill below is all we can do
  }
  if (process.env.TANDEM_LAUNCH_GROUP === "1") {
    try {
      process.kill(-process.pid, "SIGKILL"); // includes ourselves: the exit record is already written
    } catch {
      // group already empty
    }
  }
}

function leave(entry, code) {
  record(entry);
  reapDescendants();
  process.exit(code);
}

try {
  mark({}, { exclusive: true });
} catch (error) {
  let reason = `launch marker not writable: ${error.message}`;
  if (error.code === "EEXIST") {
    try {
      // The runner gave the record up (abandoned marker), or something else already sits there: never start.
      reason = JSON.parse(fs.readFileSync(markerFile, "utf8")).abandoned === true
        ? "launch abandoned by the runner (marker already present)"
        : "launch marker already present (EEXIST)";
    } catch {
      // a directory or garbage in the marker's place: reported as not writable
    }
  }
  record({ code: 65, signal: null, error: reason });
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
  // the exclusive marker is in place; the child pid is a convenience
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
