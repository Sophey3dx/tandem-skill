import { spawnSync } from "node:child_process";

// Which OS mechanism can guarantee that no descendant of a worker outlives it:
//   job            Windows Job Object with kill-on-close (scripts/lib/win-job-run.ps1)
//   systemd-scope  Linux: a transient systemd user scope (cgroup); killing the scope kills every member,
//                  a setsid() cannot leave a cgroup
//   none           nothing enforceable (macOS, Linux without a systemd user manager, …)
// TANDEM_TEST_CONFINEMENT overrides the detection (tests only).
export const CONFINEMENTS = ["job", "systemd-scope", "none"];

function has(cmd, args, env) {
  try {
    const result = spawnSync(cmd, args, { encoding: "utf8", env, windowsHide: true, timeout: 5000 });
    return { ok: result.status === 0, out: `${result.stdout ?? ""}`.trim() };
  } catch {
    return { ok: false, out: "" };
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
    const run = has("systemd-run", ["--version"], env);
    if (!run.ok) return { kind: "none", detail: "systemd-run not found" };
    const manager = has("systemctl", ["--user", "is-system-running"], env);
    if (["running", "degraded"].includes(manager.out.split(/\r?\n/)[0])) return { kind: "systemd-scope", detail: "systemd user manager available" };
    return { kind: "none", detail: `systemd user manager not available (${manager.out || "no answer"})` };
  }
  return { kind: "none", detail: `no process-tree confinement on ${process.platform}` };
}
