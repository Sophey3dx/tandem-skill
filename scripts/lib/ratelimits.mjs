import { spawn } from "node:child_process";
import { killTree, resolveCodex } from "./codex.mjs";
import { TandemError } from "./output.mjs";
import { DEFAULT_MIN_REMAINING } from "./state.mjs";

function windowOf(raw) {
  if (!raw) return null;
  const usedPercent = Number(raw.usedPercent ?? 0);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes: Number(raw.windowDurationMins ?? 0),
    resetsAt: raw.resetsAt ? new Date(Number(raw.resetsAt) * 1000).toISOString() : null
  };
}

export function normalizeRateLimits(result) {
  const limits = result?.rateLimits ?? {};
  return {
    at: new Date().toISOString(),
    planType: limits.planType ?? null,
    reached: limits.rateLimitReachedType ?? null,
    primary: windowOf(limits.primary),
    secondary: windowOf(limits.secondary)
  };
}

export function readRateLimits({ env = process.env, timeoutMs = 15000 } = {}) {
  const { cmd, prefix } = resolveCodex(env);
  return new Promise((resolve) => {
    const child = spawn(cmd, [...prefix, "app-server"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buffer = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      if (child.exitCode === null) killTree(child.pid, env); // synchronous; the pid is still ours here
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: "timeout" }), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    child.on("error", (error) => finish({ error: error.message }));
    child.on("close", () => finish({ error: "closed before answer" }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/rateLimits/read", params: {} });
        } else if (message.id === 2) {
          finish(message.error ? { error: message.error.message ?? "rpc error" } : normalizeRateLimits(message.result));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "tandem", title: "tandem", version: "0.1.0" } } });
  });
}

export function minRemainingOf(options = {}) {
  if (options["min-remaining"] === undefined) return undefined;
  const value = Number(options["min-remaining"]);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new TandemError("bad_config", `--min-remaining must be a number between 0 and 100, got "${options["min-remaining"]}".`);
  }
  return value;
}

export function budgetViolation(limits, minRemaining) {
  if (!limits || limits.error) return null;
  for (const [name, window] of [["5h", limits.primary], ["weekly", limits.secondary]]) {
    if (window && window.remainingPercent < minRemaining) {
      return { window: name, remainingPercent: window.remainingPercent, resetsAt: window.resetsAt };
    }
  }
  return null;
}

export async function ensureBudget(state, { minRemaining, env = process.env } = {}) {
  const threshold = minRemaining ?? state.config?.minRemainingPercent ?? DEFAULT_MIN_REMAINING;
  const limits = await readRateLimits({ env });
  state.rateLimits = limits;
  const violation = budgetViolation(limits, threshold);
  if (violation) {
    throw new TandemError(
      "quota_low",
      `Codex-Restnutzung im ${violation.window}-Fenster ist ${violation.remainingPercent} % (Schwelle ${threshold} %).`,
      `Kein Codex-Aufruf. Nutzer informieren; Reset um ${violation.resetsAt ?? "unbekannt"}. Mit --min-remaining 0 erzwingen, wenn es wirklich sein muss.`,
      { rateLimits: limits, threshold }
    );
  }
  return limits;
}
