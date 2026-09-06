import fs from "node:fs";
import path from "node:path";
import { killTree, minutes, normalizeEffort } from "../lib/codex.mjs";
import { guardActive } from "../lib/exchange.mjs";
import { TandemError } from "../lib/output.mjs";
import { ensureLayout, requireAbsolute } from "../lib/paths.mjs";
import { captureStartTime } from "../lib/procs.mjs";
import { renderTemplate } from "../lib/prompts.mjs";
import { ensureBudget, minRemainingOf } from "../lib/ratelimits.mjs";
import { loadState, saveState, withLock } from "../lib/state.mjs";
import {
  ACTIVE_STATUSES, activeZones, buildWorkerArgs, cancelWorker, missingBriefSections, refreshWorkers, spawnDetachedCodex, workerView
} from "../lib/workers.mjs";
import { MAX_ACTIVE_WORKERS, checkZone } from "../lib/zones.mjs";

const SUBCOMMANDS = ["start", "status", "wait", "cancel"];

function findWorker(state, id) {
  const worker = (state.workers ?? []).find((w) => w.id === id);
  if (!worker) throw new TandemError("no_such_worker", `Unknown worker "${id}".`, `Known: ${(state.workers ?? []).map((w) => w.id).join(", ") || "none"}`);
  return worker;
}

function requireId(positionals, verb) {
  const id = positionals[1];
  if (!id) throw new TandemError("bad_args", `worker ${verb} needs a worker id.`, `Example: worker ${verb} W1`);
  return id;
}

function positiveNumber(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TandemError("bad_args", `${name} must be a positive number, got "${value}".`);
  return n;
}

async function refreshAndSave(project, state) {
  const layout = ensureLayout(project);
  if (await refreshWorkers(state, { project, layout })) saveState(project, state);
}

async function start({ project, options }) {
  const zoneArg = requireAbsolute(options.zone, "--zone");
  const briefFile = requireAbsolute(options["brief-file"], "--brief-file");
  const effort = normalizeEffort(options.effort ?? "medium");
  const deadlineMs = minutes(options["deadline-min"] ?? 20);
  const model = options.model === undefined ? null : String(options.model).trim();
  if (model !== null && !/^[A-Za-z0-9._-]+$/.test(model)) throw new TandemError("bad_model", `--model must be a plain model name, got "${options.model}".`);
  const brief = fs.readFileSync(briefFile, "utf8");
  const missing = missingBriefSections(brief);
  if (missing.length > 0) {
    throw new TandemError("brief_incomplete", `Worker brief lacks sections: ${missing.join(", ")}.`, "Use references/templates/worker-brief.md: every heading there is mandatory.");
  }
  return withLock(project, async () => {
    const state = loadState(project);
    guardActive(state, options);
    await refreshAndSave(project, state);
    const active = activeZones(state);
    if (active.length >= MAX_ACTIVE_WORKERS) {
      throw new TandemError("too_many_workers", `${active.length} workers are already active (max ${MAX_ACTIVE_WORKERS}).`, "Wait for one (`worker wait <id>`) or cancel it (`worker cancel <id>`).");
    }
    const zone = checkZone({ project, zone: zoneArg, activeZones: active });
    try {
      await ensureBudget(state, { minRemaining: minRemainingOf(options) });
    } catch (error) {
      saveState(project, state);
      throw error;
    }
    const layout = ensureLayout(project);
    state.workerSeq = (state.workerSeq ?? 0) + 1;
    const id = `W${state.workerSeq}`;
    const dir = path.join(layout.workers, id);
    fs.mkdirSync(dir, { recursive: true });
    const briefPath = path.join(dir, "brief.md");
    const resultPath = path.join(dir, "result.json");
    const logPath = path.join(dir, "log.txt");
    const realProject = fs.realpathSync.native(project);
    fs.writeFileSync(briefPath, `${brief.trimEnd()}\n\n${renderTemplate("worker-contract", { PROJECT: realProject, ZONE: zone, WORKER_ID: id })}`, "utf8");
    const now = Date.now();
    // 1. Reserve the record (id, zone, deadline) BEFORE any write-capable process exists. If the runner dies
    //    from here on, the launcher's launched.json lets the next refresh adopt the pid (unknown identity).
    const worker = {
      id, zone, pid: null, procStart: null, identityPending: true, effort, model, status: "starting",
      startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + deadlineMs).toISOString(),
      briefPath, resultPath, logPath, usageBooked: false
    };
    state.workers.push(worker);
    saveState(project, state);
    // 2. Start the process.
    let pid;
    try {
      ({ pid } = spawnDetachedCodex({ args: buildWorkerArgs({ zone, effort, outFile: resultPath, model }), stdinFile: briefPath, logFile: logPath, cwd: zone }));
    } catch (error) {
      Object.assign(worker, { status: "failed", failure: "spawn_failed", errors: [error.message], finishedAt: new Date().toISOString() });
      saveState(project, state);
      throw new TandemError("spawn_failed", `Could not start the worker process: ${error.message}`, "Check `doctor` (codex binary) and the worker log.");
    }
    // 3. Persist the pid; a process that cannot be registered is killed right away, never left running.
    Object.assign(worker, { pid, status: "running" });
    try {
      saveState(project, state);
    } catch (error) {
      killTree(pid);
      throw error;
    }
    // 4. Identity (start time) right after; an unknown identity is never killed and never adopted later.
    worker.procStart = captureStartTime(pid, { attempts: 5, waitMs: 200 });
    worker.identityPending = false;
    if (worker.procStart === null) worker.identityUnknown = true;
    saveState(project, state);
    return { worker: workerView(worker), activeWorkers: active.length + 1 };
  });
}

async function status({ project, positionals }) {
  return withLock(project, async () => {
    const state = loadState(project);
    await refreshAndSave(project, state);
    const workers = positionals[1] ? [findWorker(state, positionals[1])] : state.workers ?? [];
    return { workers: workers.map(workerView), active: activeZones(state).length };
  });
}

async function wait({ project, positionals, options }) {
  const id = requireId(positionals, "wait");
  const pollMs = Math.max(500, positiveNumber(options["poll-sec"], "--poll-sec", 5) * 1000);
  const started = Date.now();
  let limit = options["timeout-min"] !== undefined ? started + minutes(options["timeout-min"]) : null;
  for (;;) {
    const view = await withLock(project, async () => {
      const state = loadState(project);
      const worker = findWorker(state, id);
      await refreshAndSave(project, state);
      return workerView(worker);
    });
    if (!ACTIVE_STATUSES.has(view.status)) return { worker: view, waitedMs: Date.now() - started }; // retry_pending returns too: the caller decides
    limit ??= Date.parse(view.deadlineAt) + 90 * 1000; // the refresh marks a timeout at the deadline
    if (Date.now() > limit) return { worker: view, waitedMs: Date.now() - started, timedOutWaiting: true };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function cancel({ project, positionals }) {
  const id = requireId(positionals, "cancel");
  return withLock(project, async () => {
    const state = loadState(project);
    const worker = findWorker(state, id);
    const layout = ensureLayout(project);
    await refreshWorkers(state, { project, layout }); // a worker that already finished keeps its result
    const { gone } = await cancelWorker(state, worker, { project, layout });
    saveState(project, state);
    return { worker: workerView(worker), gone };
  });
}

export async function runWorker(context) {
  const sub = context.positionals[0];
  if (!SUBCOMMANDS.includes(sub)) throw new TandemError("bad_subcommand", `worker needs one of: ${SUBCOMMANDS.join(", ")}.`, "Example: worker start --zone <abs> --brief-file <abs>");
  return { start, status, wait, cancel }[sub](context);
}
