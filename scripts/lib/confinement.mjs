import { spawnSync } from "node:child_process";

// Which OS mechanism can guarantee that no descendant of a worker outlives it:
//   job            Windows Job Object with kill-on-close (scripts/lib/win-job-run.ps1); the kernel kills
//                  every member when the last handle closes, no confirmation needed
//   systemd-scope  Linux: a transient systemd user scope (cgroup); a setsid() cannot leave it. Its kill is
//                  CONFIRMED (the scope must be inactive/failed, or provably not loaded any more) before a
//                  worker is ever reported finished; an unconfirmed scope keeps the worker alive and its
//                  zone reserved
//   none           nothing enforceable (macOS, Linux without a systemd user manager, …)
// TANDEM_TEST_CONFINEMENT overrides the detection; TANDEM_TEST_SYSTEMCTL / TANDEM_TEST_SYSTEMD_RUN point at
// stand-ins (.mjs files) for the two systemd binaries (tests only).
export const CONFINEMENTS = ["job", "systemd-scope", "none"];
// The launcher (sentinel) may wait; the runner holds the state lock and only takes short looks.
export const SENTINEL_SYSTEMCTL_TIMEOUT_MS = 10000;
export const RUNNER_SYSTEMCTL_TIMEOUT_MS = 3000;

function tool(env, override, name) {
  const file = env[override];
  return file ? { cmd: process.execPath, prefix: [file] } : { cmd: name, prefix: [] };
}

export function systemctlCommand(env = process.env) {
  return tool(env, "TANDEM_TEST_SYSTEMCTL", "systemctl");
}

export function systemdRunCommand(env = process.env) {
  return tool(env, "TANDEM_TEST_SYSTEMD_RUN", "systemd-run");
}

function run(cmd, args, env, timeoutMs) {
  try {
    const result = spawnSync(cmd, args, { encoding: "utf8", env, windowsHide: true, timeout: timeoutMs });
    return { ok: result.status === 0, status: result.status, out: `${result.stdout ?? ""}`.trim().split(/\r?\n/)[0] ?? "" };
  } catch {
    return { ok: false, status: null, out: "" };
  }
}

function systemctl(args, env, timeoutMs) {
  const sc = systemctlCommand(env);
  return run(sc.cmd, [...sc.prefix, "--user", ...args], env, timeoutMs);
}

export function detectConfinement(env = process.env) {
  const override = env.TANDEM_TEST_CONFINEMENT;
  if (override) {
    if (!CONFINEMENTS.includes(override)) throw new Error(`TANDEM_TEST_CONFINEMENT must be one of ${CONFINEMENTS.join(", ")}`);
    return { kind: override, detail: "forced by TANDEM_TEST_CONFINEMENT" };
  }
  if (process.platform === "win32") return { kind: "job", detail: "Windows Job Object (kill on close)" };
  if (process.platform === "linux") {
    const sdr = systemdRunCommand(env);
    if (!run(sdr.cmd, [...sdr.prefix, "--version"], env, RUNNER_SYSTEMCTL_TIMEOUT_MS).ok) return { kind: "none", detail: "systemd-run not found" };
    const manager = systemctl(["is-system-running"], env, RUNNER_SYSTEMCTL_TIMEOUT_MS);
    if (["running", "degraded"].includes(manager.out)) return { kind: "systemd-scope", detail: "systemd user manager available" };
    return { kind: "none", detail: `systemd user manager not available (${manager.out || "no answer"})` };
  }
  return { kind: "none", detail: `no process-tree confinement on ${process.platform}` };
}

// "gone"    nobody is left: the scope is inactive/failed, or the unit is provably not loaded any more (a
//           scope started with --collect disappears once it is empty; `is-active` then says "unknown" and
//           `show -p LoadState` says "not-found")
// "active"  members still run, or the scope is still winding down
// "unknown" systemctl did not answer, or answered inconsistently: the manager may be gone. Only "gone" ever
//           releases a zone.
export function scopeState(unit, env = process.env, { timeoutMs = SENTINEL_SYSTEMCTL_TIMEOUT_MS } = {}) {
  const state = systemctl(["is-active", `${unit}.scope`], env, timeoutMs);
  if (["active", "activating", "deactivating", "reloading"].includes(state.out)) return "active";
  if (["inactive", "failed"].includes(state.out)) return "gone";
  if (state.status === null || state.status === 0) return "unknown"; // no answer at all, or "active" without text
  // Not loaded ("unknown", or nothing printed with a non-zero status): distinguish a unit that provably does
  // not exist from a manager that cannot be reached.
  const load = systemctl(["show", "-p", "LoadState", "--value", `${unit}.scope`], env, timeoutMs);
  if (load.ok && load.out === "not-found") return "gone";
  return "unknown";
}

export function killScope(unit, env = process.env, { timeoutMs = SENTINEL_SYSTEMCTL_TIMEOUT_MS } = {}) {
  return systemctl(["kill", "--signal=SIGKILL", `${unit}.scope`], env, timeoutMs).ok;
}

// Sentinel use (the launcher): kill the scope and wait until it is confirmed gone. Returns true only on
// confirmation.
export function ensureScopeGone(unit, { env = process.env, attempts = 10, waitMs = 500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (scopeState(unit, env) === "gone") return true;
    killScope(unit, env);
    if (scopeState(unit, env) === "gone") return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  }
  return scopeState(unit, env) === "gone";
}

// Runner use (under the state lock): one short look, one short kill, one short look. Repeated waiting is
// the sentinel's job and that of later refreshes, never the lock holder's.
export function quickScopeGone(unit, env = process.env) {
  const opts = { timeoutMs: RUNNER_SYSTEMCTL_TIMEOUT_MS };
  if (scopeState(unit, env, opts) === "gone") return true;
  killScope(unit, env, opts);
  return scopeState(unit, env, opts) === "gone";
}
