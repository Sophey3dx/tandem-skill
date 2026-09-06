import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TandemError } from "./output.mjs";

export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
export const KILL_GRACE_MS = 5000;

export function normalizeEffort(value) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!EFFORTS.includes(effort)) {
    throw new TandemError("bad_effort", `Unsupported reasoning effort "${value}".`, `Use one of: ${EFFORTS.join(", ")}`);
  }
  return effort;
}

export function minutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TandemError("bad_deadline", `Deadline must be a positive number of minutes, got "${value}".`);
  return Math.round(n * 60 * 1000);
}

export function resolveCodex(env = process.env) {
  const override = env.TANDEM_CODEX_BIN;
  if (override) {
    return /\.(c|m)?js$/i.test(override) ? { cmd: process.execPath, prefix: [override] } : { cmd: override, prefix: [] };
  }
  if (process.platform !== "win32") return { cmd: "codex", prefix: [] };
  const where = spawnSync("where", ["codex"], { encoding: "utf8", windowsHide: true });
  const candidates = String(where.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const exe = candidates.find((c) => /\.exe$/i.test(c));
  if (exe) return { cmd: exe, prefix: [] };
  const shim = candidates.find((c) => /\.cmd$/i.test(c));
  if (shim) {
    const js = path.join(path.dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(js)) return { cmd: process.execPath, prefix: [js] };
  }
  throw new TandemError(
    "codex_not_found",
    "Could not locate the codex CLI.",
    "Install with `npm install -g @openai/codex` or set TANDEM_CODEX_BIN to codex.exe or bin/codex.js."
  );
}

// Returns true when the kill command reported success. TANDEM_TEST_NO_KILL=1 skips the kill (tests only).
export function killTree(pid, env = process.env) {
  if (!pid || env.TANDEM_TEST_NO_KILL === "1") return false;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return result.status === 0;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

export function parseJsonl(text) {
  const events = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // not an event line
    }
  }
  return events;
}

export function classifyFailure({ status, timedOut, stderr = "", stdout = "" }) {
  if (timedOut) return "timeout";
  if (status === 0) return null;
  const text = `${stderr}\n${stdout}`;
  if (/session not found|thread .*not found|no session|could not find (the )?(thread|session)|rollout .*not found/i.test(text)) return "thread_lost";
  if (/usage limit|rate limit|too many requests|insufficient_quota|\b429\b|quota/i.test(text)) return "quota";
  if (/not logged in|login required|unauthorized|\b401\b|codex login/i.test(text)) return "auth";
  return "codex_failed";
}

const HINTS = {
  thread_lost: "Der Thread ist nicht mehr resumierbar. Seed aus dem Ledger schreiben und `rotate --seed-file <abs>` ausführen.",
  quota: "Codex-Limit erreicht. tandem ist jetzt pausiert; Nutzer informieren, ohne Checkpoints weiterarbeiten, später `unpause`.",
  auth: "Codex ist nicht eingeloggt: `codex login` ausführen.",
  timeout: "Deadline überschritten, Prozessbaum beendet. Einmal manuell erneut versuchen, nie blind wiederholen.",
  codex_failed: "Log neben der Antwortdatei prüfen (.log)."
};

export function failureToError(result, kind) {
  const tail = String(result.stderr || result.stdout || "").trim().split(/\r?\n/).filter(Boolean).slice(-5).join(" | ");
  return new TandemError(result.failure, `Codex ${kind} failed (${result.failure}): ${tail || "no output"}`, HINTS[result.failure], {
    durationMs: result.durationMs,
    status: result.status
  });
}

export function runCodex({ args, promptFile = null, cwd, timeoutMs, env = process.env, logFile = null }) {
  const { cmd, prefix } = resolveCodex(env);
  const fullArgs = [...prefix, ...args];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, fullArgs, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;
    let settled = false;
    let graceTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killed = killTree(child.pid, env);
      // If "close" never arrives (kill failed, handles held), resolve anyway after a grace period.
      graceTimer = setTimeout(() => finish(null), KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {});
    const finish = (status, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      if (logFile) {
        try {
          fs.writeFileSync(logFile, `# command\n${JSON.stringify([cmd, ...fullArgs])}\n# stdout\n${stdout}\n# stderr\n${stderr}\n`, "utf8");
        } catch {
          // logging is best effort
        }
      }
      const result = { status, timedOut, killed, pid: child.pid, stdout, stderr, events: parseJsonl(stdout), durationMs: Date.now() - started, spawnError };
      result.failure = spawnError ? "codex_failed" : classifyFailure(result);
      resolve(result);
    };
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
    if (promptFile) {
      const stream = fs.createReadStream(promptFile);
      stream.on("error", () => child.stdin.end());
      stream.pipe(child.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export function threadIdFromEvents(events = []) {
  return events.find((e) => e?.type === "thread.started")?.thread_id ?? null;
}

export function readLastMessage(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

export function codexVersion(env = process.env) {
  const { cmd, prefix } = resolveCodex(env);
  const result = spawnSync(cmd, [...prefix, "--version"], { encoding: "utf8", windowsHide: true, env });
  const match = /(\d+\.\d+\.\d+)/.exec(`${result.stdout}${result.stderr}`);
  return match ? match[1] : null;
}

export function loginStatus(env = process.env) {
  const { cmd, prefix } = resolveCodex(env);
  const result = spawnSync(cmd, [...prefix, "login", "status"], { encoding: "utf8", windowsHide: true, env });
  const detail = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] ?? "";
  return { loggedIn: result.status === 0, detail };
}

export function buildStartArgs({ project, effort, outFile }) {
  return ["exec", "--json", "-C", project, "-s", "read-only", "--skip-git-repo-check", "-c", `model_reasoning_effort=${effort}`, "-o", outFile, "-"];
}

export function buildResumeArgs({ threadId, effort, schemaPath, outFile }) {
  return [
    "exec", "resume", threadId, "--skip-git-repo-check", "--json",
    "-c", "sandbox_mode=read-only", "-c", `model_reasoning_effort=${effort}`,
    "--output-schema", schemaPath, "-o", outFile, "-"
  ];
}
