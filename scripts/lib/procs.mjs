import { spawnSync } from "node:child_process";
import { pidAlive } from "./state.mjs";

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Start time of a process in epoch ms (truncated to the platform's resolution: ms on Windows, seconds on
// POSIX), or null when it does not exist. Pids are recycled; the start time makes the identity of a worker
// verifiable before it is killed or declared alive. The same source and truncation are used for capture and
// later checks, so identities are compared EXACTLY.
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") {
    const script = `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { '' }`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const iso = String(result.stdout ?? "").trim().replace(/(\.\d{3})\d+/, "$1"); // keep ms, drop 100-ns digits
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const ms = Date.parse(String(result.stdout ?? "").trim());
  return Number.isFinite(ms) ? Math.floor(ms / 1000) * 1000 : null;
}

// Right after a spawn the process may not be visible yet; retry briefly. Returns null when it never was.
export function captureStartTime(pid, { attempts = 10, waitMs = 200 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const start = processStartTime(pid);
    if (start !== null) return start;
    if (!pidAlive(pid)) return null;
    sleepSync(waitMs);
  }
  return null;
}

// True only when the pid is alive AND the start time matches EXACTLY (same source, same truncation). With an
// unknown identity (procStart null) this only reports liveness; callers must never kill on that basis.
export function sameProcess({ pid, procStart }) {
  if (!pidAlive(pid)) return false;
  if (procStart === null || procStart === undefined) return true;
  const start = processStartTime(pid);
  if (start === null) return false;
  return start === procStart;
}
