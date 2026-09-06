import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildResumeArgs, classifyFailure, killTree, parseJsonl, resolveCodex, runCodex, threadIdFromEvents } from "./codex.mjs";
import { noteFailure } from "./exchange.mjs";
import { sameProcess, sleepSync } from "./procs.mjs";
import { ensureBudget } from "./ratelimits.mjs";
import { parseReplyFile, schemaPath } from "./schema.mjs";
import { addUsage } from "./state.mjs";
import { extractUsage } from "./usage.mjs";

export const TERMINAL_STATUSES = new Set(["done", "partial", "blocked", "timeout", "orphaned", "cancelled", "invalid_output", "failed"]);
export const ACTIVE_STATUSES = new Set(["running", "finishing", "killing"]);
export const REQUIRED_BRIEF_SECTIONS = ["Auftragstyp", "Baseline", "Ziel", "Nicht-Ziele", "Erlaubte Dateien", "Schnittstellen", "Akzeptanztests", "Löschrechte", "Stop-Bedingungen", "Kontext aus dem Ledger"];
const KILL_CONFIRM_MS = 5000;
const RETRY_EFFORT = "low";
const RETRY_DEADLINE_MS = 5 * 60 * 1000;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function missingBriefSections(brief) {
  return REQUIRED_BRIEF_SECTIONS.filter((section) => !new RegExp(`^#{1,3}\\s*${escapeRegExp(section)}\\s*$`, "im").test(brief));
}

export function buildWorkerArgs({ zone, effort, outFile, model = null }) {
  return [
    "exec", "--json", "-C", zone, "-s", "workspace-write", "--skip-git-repo-check",
    ...(model ? ["-m", model] : []),
    "-c", `model_reasoning_effort=${effort}`, "--output-schema", schemaPath("worker-result"), "-o", outFile, "-"
  ];
}

// Starts codex detached WITHOUT any shell: stdin is the opened brief file, stdout and stderr are the opened
// log file (inherited descriptors), so no cmd.exe/sh quoting or %VAR% expansion can ever rewrite a validated
// path. The pid is the codex launcher itself (`taskkill /T` kills its tree; on POSIX the detached process
// leads its own group). Identity (start time) is captured by the caller AFTER the record is persisted.
export function spawnDetachedCodex({ args, stdinFile, logFile, cwd, env = process.env }) {
  const { cmd, prefix } = resolveCodex(env);
  const inFd = fs.openSync(stdinFile, "r");
  const outFd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(cmd, [...prefix, ...args], { cwd, env, detached: true, stdio: [inFd, outFd, outFd], windowsHide: true });
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
  child.unref();
  return { pid: child.pid };
}

function readLogText(logPath) {
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

// Usage from the log: JSONL events first, `tokens used` stderr line as fallback. Booked once, after exit.
export function bookWorkerUsage(state, worker) {
  if (worker.usageBooked) return;
  const text = readLogText(worker.logPath);
  const usage = extractUsage({ events: parseJsonl(text), stderr: text });
  if (usage) addUsage(state, "worker", usage);
  worker.usageBooked = true;
}

function finish(state, worker, status, now, extra = {}) {
  Object.assign(worker, { status, finishedAt: new Date(now).toISOString(), ...extra });
  bookWorkerUsage(state, worker);
}

// Kills only a process that is verifiably ours (pid AND start time), then waits up to KILL_CONFIRM_MS for it
// to disappear. Without a verified identity nothing is ever killed.
export function killWorker(worker, env = process.env) {
  if (worker.procStart === null || worker.procStart === undefined) {
    return sameProcess(worker) ? { gone: false, killed: false, reason: "identity_unknown" } : { gone: true, killed: false };
  }
  if (!sameProcess(worker)) return { gone: true, killed: false };
  killTree(worker.pid, env);
  const until = Date.now() + KILL_CONFIRM_MS;
  while (Date.now() < until) {
    if (!sameProcess(worker)) return { gone: true, killed: true };
    sleepSync(250);
  }
  return { gone: false, killed: false };
}

// Exactly one schema retry for an invalid result: resume the worker's own thread read-only and ask for the
// JSON report only. Budget-checked like every model call; a budget refusal leaves the retry pending (it is
// attempted again on the next refresh), a model failure ends the worker with that failure and the usual
// quota policy. Returns { parsed, errors, pending?, failure? }.
async function retryWorkerResult(state, worker, { project, layout, env }) {
  const threadId = threadIdFromEvents(parseJsonl(readLogText(worker.logPath)));
  if (!threadId) {
    worker.retried = true;
    return { parsed: null, errors: ["no thread id in the worker log; cannot resume"] };
  }
  try {
    await ensureBudget(state, { env });
  } catch (error) {
    return { parsed: null, errors: [`retry pending: ${error.code} ${error.message}`], pending: true };
  }
  worker.retried = true; // the model call happens now
  const promptFile = path.join(layout.workers, worker.id, "retry.md");
  fs.writeFileSync(promptFile, "Deine Abschlussmeldung war nicht schema-konform. Führe KEINE weitere Arbeit aus. Gib jetzt ausschließlich die JSON-Abschlussmeldung nach dem Schema worker-result aus (status DONE|PARTIAL|BLOCKED, touchedFiles, tests, remaining, blockers, notes), ohne Text davor oder danach.\n", "utf8");
  const result = await runCodex({
    args: buildResumeArgs({ threadId, effort: RETRY_EFFORT, schemaPath: schemaPath("worker-result"), outFile: worker.resultPath }),
    promptFile, cwd: project, timeoutMs: RETRY_DEADLINE_MS, env, logFile: path.join(layout.workers, worker.id, "retry.log")
  });
  addUsage(state, "worker", extractUsage(result));
  if (result.failure) {
    noteFailure(state, result);
    return { parsed: null, errors: [`retry failed: ${result.failure}`], failure: result.failure };
  }
  return parseReplyFile(worker.resultPath, "worker-result");
}

async function settleResult(state, worker, { project, layout, env, now }) {
  let outcome = parseReplyFile(worker.resultPath, "worker-result");
  if (!outcome.parsed && !worker.retried) outcome = await retryWorkerResult(state, worker, { project, layout, env });
  if (outcome.parsed) {
    finish(state, worker, outcome.parsed.status.toLowerCase(), now, { result: outcome.parsed });
  } else if (outcome.pending) {
    worker.status = "retry_pending"; // not terminal, zone free; retried on the next refresh
    worker.retryErrors = outcome.errors;
  } else if (outcome.failure) {
    finish(state, worker, "failed", now, { failure: outcome.failure, errors: outcome.errors });
  } else {
    finish(state, worker, "invalid_output", now, { errors: outcome.errors });
  }
}

// Brings every non-terminal worker up to date. Terminal only after the process is verifiably gone.
// Pending schema retries are model calls: they rest while tandem is paused or stopped.
export async function refreshWorkers(state, { project, layout, now = Date.now(), env = process.env } = {}) {
  let changed = false;
  for (const worker of state.workers ?? []) {
    if (worker.status === "retry_pending") {
      if (state.paused || state.stopped) continue;
      await settleResult(state, worker, { project, layout, env, now });
      changed = worker.status !== "retry_pending" || changed;
      continue;
    }
    if (!ACTIVE_STATUSES.has(worker.status)) continue;
    // procStart is never taken over from the current pid owner later; an unknown identity stays unknown.
    if (worker.procStart === null || worker.procStart === undefined) worker.identityUnknown = true;
    const alive = sameProcess(worker);
    const hasResult = fs.existsSync(worker.resultPath);
    if (worker.status === "killing") {
      if (alive) continue;
      finish(state, worker, worker.killReason, now, { killFailed: false });
      changed = true;
      continue;
    }
    if (alive) {
      if (hasResult && worker.status !== "finishing") {
        worker.status = "finishing"; // result written, process still running: zone stays reserved
        changed = true;
      } else if (now > Date.parse(worker.deadlineAt)) {
        const kill = killWorker(worker, env);
        if (kill.gone) finish(state, worker, "timeout", now, { killReason: "timeout" });
        else Object.assign(worker, { status: "killing", killReason: "timeout", killFailed: true, killBlockedBy: kill.reason ?? "kill_failed" });
        changed = true;
      }
      continue;
    }
    // Process gone.
    if (hasResult) {
      await settleResult(state, worker, { project, layout, env, now });
    } else {
      const failure = classifyFailure({ status: 1, timedOut: false, stderr: readLogText(worker.logPath) });
      if (failure === "quota") state.paused = true;
      finish(state, worker, failure === "codex_failed" ? "orphaned" : "failed", now, { failure });
    }
    changed = true;
  }
  return changed;
}

export function cancelWorker(state, worker, env = process.env) {
  if (worker.status === "retry_pending") {
    finish(state, worker, "cancelled", Date.now(), { killReason: "cancelled", killFailed: false });
    return { gone: true, changed: true };
  }
  if (!ACTIVE_STATUSES.has(worker.status)) return { gone: true, changed: false };
  const kill = killWorker(worker, env);
  if (kill.gone) finish(state, worker, "cancelled", Date.now(), { killReason: "cancelled", killFailed: false });
  else Object.assign(worker, { status: "killing", killReason: "cancelled", killFailed: true, killBlockedBy: kill.reason ?? "kill_failed" });
  return { gone: kill.gone, changed: true };
}

export function activeZones(state) {
  return (state.workers ?? []).filter((w) => ACTIVE_STATUSES.has(w.status)).map((w) => w.zone);
}

// Everything that is not finished yet: active workers plus pending retries (used by `stop`).
export function unfinishedWorkers(state) {
  return (state.workers ?? []).filter((w) => ACTIVE_STATUSES.has(w.status) || w.status === "retry_pending");
}

export function workerView(worker) {
  const { usageBooked, ...view } = worker;
  return view;
}
