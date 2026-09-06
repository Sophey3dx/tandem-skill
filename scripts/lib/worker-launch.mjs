#!/usr/bin/env node
// Detached worker launcher. The runner never waits for a worker (each runner call is short-lived), so the
// exit code of codex would be lost. This wrapper runs codex with INHERITED stdio (stdin = the brief file,
// stdout/stderr = the log file, both opened by the runner) and appends exactly one JSON line
// {"type":"tandem.exit","code":…,"signal":…} to the log when codex has exited. No shell is involved.
// Before codex starts it writes launched.json (its own pid) next to the log, so a worker whose runner died
// between reserving the record and saving the pid can still be found and is never left unregistered.
// Usage: node worker-launch.mjs <absolute logFile> <cmd> [args...]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

function mark(extra = {}) {
  try {
    fs.writeFileSync(markerFile, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...extra })}\n`, "utf8");
  } catch {
    // best effort: the runner normally persists the pid itself
  }
}

mark(); // before anything write-capable exists
let child;
try {
  child = spawn(cmd, args, { stdio: "inherit", windowsHide: true });
} catch (error) {
  record({ code: 127, signal: null, error: error.message });
  process.exit(127);
}
mark({ childPid: child.pid ?? null });

let reported = false;
child.on("error", (error) => {
  if (reported) return;
  reported = true;
  record({ code: 127, signal: null, error: error.message });
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (reported) return;
  reported = true;
  record({ code, signal });
  process.exit(code ?? 1);
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
