import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildResumeArgs, classifyFailure, killTree, parseJsonl, resolveCodex, runCodex, threadIdFromEvents } from "./codex.mjs";
import { noteFailure } from "./exchange.mjs";
import { processState, sameProcess, sleepSync } from "./procs.mjs";
import { ensureBudget } from "./ratelimits.mjs";
import { parseReplyFile, parseReplyText, schemaPath } from "./schema.mjs";
import { addUsage } from "./state.mjs";
import { extractUsage } from "./usage.mjs";

export const TERMINAL_STATUSES = new Set(["done", "partial", "blocked", "timeout", "orphaned", "cancelled", "invalid_output", "failed"]);
// `starting`: the record (id, zone, deadline) is persisted, the pid is not yet. The zone is reserved already.
export const ACTIVE_STATUSES = new Set(["starting", "running", "finishing", "killing"]);
export const REQUIRED_BRIEF_SECTIONS = ["Auftragstyp", "Baseline", "Ziel", "Nicht-Ziele", "Erlaubte Dateien", "Schnittstellen", "Akzeptanztests", "Löschrechte", "Stop-Bedingungen", "Kontext aus dem Ledger"];
export const LAUNCH_MARKER = "launched.json";
const LAUNCHER = fileURLToPath(new URL("./worker-launch.mjs", import.meta.url));
const KILL_CONFIRM_MS = 5000;
const STARTING_GRACE_MS = 10 * 1000;
const RETRY_EFFORT = "low";
const RETRY_DEADLINE_MS = 5 * 60 * 1000;
// Failure classes that mean "codex refused or lost the session" rather than "the process vanished".
const FAILED_CLASSES = new Set(["quota", "auth", "thread_lost"]);

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

// Starts codex detached WITHOUT any shell, through the tiny launcher in worker-launch.mjs: stdin is the
// opened brief file, stdout and stderr are the opened log file (inherited descriptors), so no cmd.exe/sh
// quoting or %VAR% expansion can ever rewrite a validated path. The launcher writes launched.json (its pid)
// before codex starts and appends a final {"type":"tandem.exit"} line to the log when codex exits, so the
// exit code of a process nobody waits for is known. The pid is the launcher (`taskkill /T` kills its tree;
// on POSIX the detached process leads its own group). Identity (start time) is captured by the caller.
// Resolves once the launcher process exists; a start failure (e.g. a cwd that vanished after the zone check)
// rejects with the spawn error instead of surfacing as an unhandled 'error' event.
export async function spawnDetachedCodex({ args, stdinFile, logFile, cwd, confinement = "none", env = process.env }) {
  const { cmd, prefix } = resolveCodex(env);
  const inFd = fs.openSync(stdinFile, "r");
  const outFd = fs.openSync(logFile, "a");
  let child;
  try {
    // detached: on POSIX the launcher leads its own process group (TANDEM_LAUNCH_GROUP tells it so).
    // TANDEM_CONFINEMENT names the OS mechanism the launcher wraps codex in (lib/confinement.mjs).
    child = spawn(process.execPath, [LAUNCHER, logFile, cmd, ...prefix, ...args], { cwd, env: { ...env, TANDEM_LAUNCH_GROUP: "1", TANDEM_CONFINEMENT: confinement }, detached: true, stdio: [inFd, outFd, outFd], windowsHide: true });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
  child.on("error", () => {}); // never let a late error event crash the runner
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

function workerEvents(worker) {
  return parseJsonl(readLogText(worker.logPath));
}

// The launcher's exit record, or null when the log has none (launcher killed from outside, log truncated).
export function exitInfo(events) {
  const record = [...events].reverse().find((e) => e?.type === "tandem.exit");
  if (!record) return null;
  return { code: Number.isInteger(record.code) ? record.code : null, signal: record.signal ?? null, error: record.error ?? null };
}

// The worker's final report: the -o file when codex wrote it, otherwise the final agent message of a
// completed turn in the JSONL log. Codex writes the -o file from exactly that message, but only after its
// internal shutdown; a codex that dies during shutdown (seen on Windows after sandboxed commands) leaves
// the message in the log and nothing else. Returns { raw, source: "file" | "log" } or null.
export function readWorkerResult(worker, events = workerEvents(worker)) {
  if (fs.existsSync(worker.resultPath)) return { raw: fs.readFileSync(worker.resultPath, "utf8"), source: "file" };
  if (!events.some((e) => e?.type === "turn.completed")) return null;
  const message = [...events].reverse().find((e) => e?.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string" && e.item.text.trim() !== "");
  return message ? { raw: message.item.text, source: "log" } : null;
}

function markerPath(worker) {
  return path.join(path.dirname(worker.logPath), LAUNCH_MARKER);
}

// launched.json next to the log: created exclusively by the launcher before codex starts. An "abandoned"
// marker (written by the runner when it gave the record up) carries no pid and counts as absent.
export function launchMarker(worker) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(worker), "utf8"));
    return Number.isInteger(marker.pid) && marker.pid > 0 ? marker : null;
  } catch {
    return null;
  }
}

// Gives a reserved record up: creates the marker EXCLUSIVELY with abandoned=true, so a launcher that is only
// now getting scheduled fails its own exclusive create and never starts codex. Returns
//   "abandoned"       our marker is in place, or nothing can ever claim the path (a directory sits there, or
//                     the worker directory is gone): no launcher can start from it
//   "launcher_found"  a launcher marker with a pid exists: the caller adopts that pid
//   "unresolved"      the path is taken but not readable as either (a launcher may be writing it right now),
//                     or the marker could not be written for another reason: keep the record reserved and
//                     try again on the next refresh
function abandonLaunch(worker) {
  const file = markerPath(worker);
  try {
    fs.writeFileSync(file, `${JSON.stringify({ abandoned: true, at: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "wx" });
    return "abandoned";
  } catch (error) {
    if (error.code === "ENOENT") return "abandoned"; // the worker directory is gone: the launcher cannot write its marker either
    if (error.code !== "EEXIST" && error.code !== "EISDIR") return "unresolved";
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return "unresolved";
    }
    if (stat.isDirectory()) return "abandoned"; // the launcher's exclusive create fails there too (exit 65)
    if (launchMarker(worker)) return "launcher_found";
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).abandoned === true ? "abandoned" : "unresolved";
    } catch {
      return "unresolved"; // empty or partial: the launcher is still writing
    }
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
// to disappear. Without a verified identity nothing is ever killed: an unknown identity (never captured), an
// unverifiable one (the start-time query fails right now) and a record without a pid all leave the worker
// active as `killing`; every refresh tries again.
export function killWorker(worker, env = process.env) {
  if (worker.pid === null || worker.pid === undefined) return { gone: false, killed: false, reason: "starting" };
  const state = processState(worker);
  if (state === "gone" || state === "foreign") return { gone: true, killed: false };
  if (state === "unverified") {
    return { gone: false, killed: false, reason: worker.procStart === null || worker.procStart === undefined ? "identity_unknown" : "identity_unverified" };
  }
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
  const threadId = threadIdFromEvents(workerEvents(worker));
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
  return { ...parseReplyFile(worker.resultPath, "worker-result"), source: "retry" };
}

// The retry is a model call: while tandem is paused or stopped it rests as `retry_pending`, exactly like a
// retry the budget guard refused. The finished run's usage is booked either way.
async function settleResult(state, worker, { project, layout, env, now }) {
  const found = readWorkerResult(worker);
  let outcome = found
    ? { ...parseReplyText(found.raw, "worker-result"), source: found.source }
    : { parsed: null, errors: [`reply file missing: ${worker.resultPath}`], source: null };
  if (!outcome.parsed && !worker.retried) {
    outcome = state.paused || state.stopped
      ? { parsed: null, errors: [...outcome.errors, "retry pending: tandem is paused or stopped"], pending: true }
      : await retryWorkerResult(state, worker, { project, layout, env });
  }
  if (outcome.parsed) {
    finish(state, worker, outcome.parsed.status.toLowerCase(), now, { result: outcome.parsed, resultSource: outcome.source });
  } else if (outcome.pending) {
    worker.status = "retry_pending"; // not terminal, zone free; retried on the next refresh
    worker.retryErrors = outcome.errors;
    bookWorkerUsage(state, worker); // the original run is over; its tokens count now, not after the retry
  } else if (outcome.failure) {
    finish(state, worker, "failed", now, { failure: outcome.failure, errors: outcome.errors });
  } else {
    finish(state, worker, "invalid_output", now, { errors: outcome.errors });
  }
}

function recordExit(worker, events) {
  const exit = exitInfo(events);
  if (!exit) return null;
  Object.assign(worker, { exitCode: exit.code, exitSignal: exit.signal });
  if (exit.error) worker.exitError = exit.error;
  return exit;
}

// The process is gone: a complete report (file or log) is the result, whatever the caller intended;
// otherwise the worker ends with `fallback` (orphaned/failed classification, a kill reason, …).
async function settleGone(state, worker, ctx, fallback) {
  const events = workerEvents(worker);
  const exit = recordExit(worker, events);
  if (readWorkerResult(worker, events)) {
    await settleResult(state, worker, ctx);
    return;
  }
  fallback(exit);
}

function orphanOrFail(state, worker, now, exit) {
  // The launcher could not start codex at all (marker not writable, binary missing, job setup failed).
  if (exit?.error) {
    finish(state, worker, "failed", now, { failure: "spawn_failed", errors: [exit.error] });
    return;
  }
  // Exit code 0 without any report is "no_result"; a missing exit record (launcher killed) counts as 1.
  const failure = classifyFailure({ status: exit?.code ?? 1, timedOut: false, stderr: readLogText(worker.logPath) }) ?? "no_result";
  if (failure === "quota") state.paused = true;
  finish(state, worker, FAILED_CLASSES.has(failure) ? "failed" : "orphaned", now, { failure });
}

// A record without a persisted pid (the runner died between reserving the record and saving the pid):
// adopt the pid from the launcher's marker with an unknown identity (never killed, zone reserved until the
// process exits by itself), or give the record up once the grace period has passed without a launcher.
// Returns "resolved" | "pending" | "lost".
function resolvePid(worker, now) {
  if (worker.pid !== null && worker.pid !== undefined) return "resolved";
  const adopt = (marker) => {
    Object.assign(worker, { pid: marker.pid, identityPending: false, identityUnknown: true, pidSource: LAUNCH_MARKER });
    if (worker.status === "starting") worker.status = "running";
    return "resolved";
  };
  const marker = launchMarker(worker);
  if (marker) return adopt(marker);
  if (now - Date.parse(worker.startedAt) <= STARTING_GRACE_MS) return "pending";
  // Grace over: claim the marker so a late launcher cannot start; if it beat us to it, track it instead.
  // Anything unclear keeps the reservation (zone stays blocked) and is re-checked on the next refresh.
  const claim = abandonLaunch(worker);
  if (claim === "abandoned") {
    delete worker.launchUnresolved;
    return "lost";
  }
  if (claim === "launcher_found") {
    delete worker.launchUnresolved;
    return adopt(launchMarker(worker));
  }
  worker.launchUnresolved = true;
  return "pending";
}

// Brings every non-terminal worker up to date. Terminal only after the process is verifiably gone.
// Pending schema retries are model calls: they rest while tandem is paused or stopped.
export async function refreshWorkers(state, { project, layout, now = Date.now(), env = process.env } = {}) {
  const ctx = { project, layout, env, now };
  let changed = false;
  for (const worker of state.workers ?? []) {
    if (worker.status === "retry_pending") {
      if (state.paused || state.stopped) continue;
      await settleResult(state, worker, ctx);
      changed = true; // the budget check refreshed state.rateLimits and retryErrors even when still pending
      continue;
    }
    if (!ACTIVE_STATUSES.has(worker.status)) continue;
    const resolution = resolvePid(worker, now);
    if (resolution === "pending") continue;
    if (resolution === "lost") {
      if (worker.status === "killing") finish(state, worker, worker.killReason, now, { killFailed: false });
      else finish(state, worker, "failed", now, { failure: "spawn_lost" });
      changed = true;
      continue;
    }
    if (worker.pidSource === LAUNCH_MARKER && worker.status === "running" && !worker.adoptedAt) {
      worker.adoptedAt = new Date(now).toISOString();
      changed = true;
    }
    // procStart is never taken over from the current pid owner later; an unknown identity stays unknown.
    if (worker.procStart === null || worker.procStart === undefined) worker.identityUnknown = true;
    const alive = sameProcess(worker);
    const hasResult = fs.existsSync(worker.resultPath);
    if (worker.status === "killing") {
      if (alive) {
        // Try again on every refresh: a kill that failed, or that was blocked by an unverifiable identity,
        // must not leave a worker (and its zone) active forever once the identity is verifiable again.
        const kill = killWorker(worker, env);
        if (!kill.gone) {
          const blockedBy = kill.reason ?? "kill_failed";
          if (worker.killBlockedBy !== blockedBy) {
            worker.killBlockedBy = blockedBy;
            changed = true;
          }
          continue;
        }
      }
      await settleGone(state, worker, ctx, () => finish(state, worker, worker.killReason, now, { killFailed: false }));
      changed = true;
      continue;
    }
    if (alive) {
      if (hasResult && worker.status !== "finishing") {
        worker.status = "finishing"; // result written, process still running: zone stays reserved
        changed = true;
      } else if (now > Date.parse(worker.deadlineAt)) {
        const kill = killWorker(worker, env);
        if (kill.gone) await settleGone(state, worker, ctx, () => finish(state, worker, "timeout", now, { killReason: "timeout" }));
        else Object.assign(worker, { status: "killing", killReason: "timeout", killFailed: true, killBlockedBy: kill.reason ?? "kill_failed" });
        changed = true;
      }
      continue;
    }
    // Process gone: the -o file or, failing that, the final message in the log is the report.
    await settleGone(state, worker, ctx, (exit) => orphanOrFail(state, worker, now, exit));
    changed = true;
  }
  return changed;
}

// Cancels one worker. Callers refresh first, so a process that already finished is settled as its result,
// not discarded. Even a kill that finds the process gone keeps a complete report.
export async function cancelWorker(state, worker, { project, layout, env = process.env, now = Date.now() } = {}) {
  const ctx = { project, layout, env, now };
  if (worker.status === "retry_pending") {
    finish(state, worker, "cancelled", now, { killReason: "cancelled", killFailed: false });
    return { gone: true, changed: true };
  }
  if (!ACTIVE_STATUSES.has(worker.status)) return { gone: true, changed: false };
  const kill = killWorker(worker, env);
  if (!kill.gone) {
    Object.assign(worker, { status: "killing", killReason: "cancelled", killFailed: true, killBlockedBy: kill.reason ?? "kill_failed" });
    return { gone: false, changed: true };
  }
  await settleGone(state, worker, ctx, () => finish(state, worker, "cancelled", now, { killReason: "cancelled", killFailed: false }));
  return { gone: true, changed: true };
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
