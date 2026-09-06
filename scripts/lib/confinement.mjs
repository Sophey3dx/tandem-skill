import { spawnSync } from "node:child_process";

// Which OS mechanism can guarantee that no descendant of a worker outlives it:
//   job            Windows Job Object with kill-on-close (scripts/lib/win-job-run.ps1); the kernel kills
//                  every member when the last handle closes, no confirmation needed
//   systemd-scope  Linux: a transient systemd user scope (cgroup); a setsid() cannot leave it. Its kill is
//                  CONFIRMED (`systemctl --user is-active` must report inactive/failed) before a worker is
//                  ever reported finished; an unconfirmed scope keeps the worker alive and its zone reserved
//   none           nothing enforceable (macOS, Linux without a systemd user manager, …)
// TANDEM_TEST_CONFINEMENT overrides the detection; TANDEM_TEST_SYSTEMCTL / TANDEM_TEST_SYSTEMD_RUN point at
// stand-ins (.mjs files) for the two systemd binaries (tests only).
export const CONFINEMENTS = ["job", "systemd-scope", "none"];
const SYSTEMCTL_TIMEOUT_MS = 10000;

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

function run(cmd, args, env) {
  try {
    const result = spawnSync(cmd, args, { encoding: "utf8", env, windowsHide: true, timeout: SYSTEMCTL_TIMEOUT_MS });
    return { ok: result.status === 0, status: result.status, out: `${result.stdout ?? ""}`.trim().split(/\r?\n/)[0] ?? "" };
  } catch {
    return { ok: false, status: null, out: "" };
  }
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
    if (!run(sdr.cmd, [...sdr.prefix, "--version"], env).ok) return { kind: "none", detail: "systemd-run not found" };
    const sc = systemctlCommand(env);
    const manager = run(sc.cmd, [...sc.prefix, "--user", "is-system-running"], env);
    if (["running", "degraded"].includes(manager.out)) return { kind: "systemd-scope", detail: "systemd user manager available" };
    return { kind: "none", detail: `systemd user manager not available (${manager.out || "no answer"})` };
  }
  return { kind: "none", detail: `no process-tree confinement on ${process.platform}` };
}

// "gone" (inactive/failed/not found: nobody is left in the scope), "active" (members still run, or the
// scope is still winding down) or "unknown" (systemctl did not answer: the manager may be gone). Only
// "gone" ever releases a zone.
export function scopeState(unit, env = process.env) {
  const sc = systemctlCommand(env);
  const result = run(sc.cmd, [...sc.prefix, "--user", "is-active", `${unit}.scope`], env);
  if (["active", "activating", "deactivating", "reloading"].includes(result.out)) return "active";
  if (["inactive", "failed"].includes(result.out)) return "gone";
  return "unknown";
}

export function killScope(unit, env = process.env) {
  const sc = systemctlCommand(env);
  return run(sc.cmd, [...sc.prefix, "--user", "kill", "--signal=SIGKILL", `${unit}.scope`], env).ok;
}

// Kills the scope and waits until it is confirmed gone. Returns true only on confirmation.
export function ensureScopeGone(unit, { env = process.env, attempts = 10, waitMs = 500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (scopeState(unit, env) === "gone") return true;
    killScope(unit, env);
    if (scopeState(unit, env) === "gone") return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  }
  return scopeState(unit, env) === "gone";
}
