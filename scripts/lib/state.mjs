import fs from "node:fs";
import { TandemError } from "./output.mjs";
import { tandemLayout } from "./paths.mjs";

export const STATE_VERSION = 1;
export const MODES = ["begleiter", "plan", "sparring", "split"];
export const LOCK_STALE_MS = 30 * 60 * 1000;
export const DEFAULT_MIN_REMAINING = 10;

export function emptyUsage() {
  return { input: 0, output: 0, total: 0, runs: 0 };
}

export function defaultState(projectRoot) {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    project: projectRoot,
    createdAt: now,
    threadId: null,
    threadStartedAt: null,
    threadHistory: [],
    mode: "begleiter",
    paused: false,
    stopped: false,
    codexVersion: null,
    contacts: 0,
    lastContact: null,
    plan: { hash: null, round: 0, planFile: null, verdicts: [] },
    workers: [],
    server: null,
    usage: { total: emptyUsage(), byKind: {}, session: emptyUsage() },
    rateLimits: null,
    config: { minRemainingPercent: DEFAULT_MIN_REMAINING },
    design: { rounds: [] }
  };
}

export function stateExists(projectRoot) {
  return fs.existsSync(tandemLayout(projectRoot).stateFile);
}

export function loadState(projectRoot) {
  const { stateFile, backupFile } = tandemLayout(projectRoot);
  if (!fs.existsSync(stateFile)) {
    throw new TandemError("not_started", "No .tandem/state.json in this project.", "Run `start --summary-file <abs>` first.");
  }
  const raw = fs.readFileSync(stateFile, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new TandemError("state_corrupt", `state.json is not valid JSON: ${error.message}`, `Restore it from ${backupFile}.`);
  }
}

export function saveState(projectRoot, state) {
  const { root, stateFile, backupFile } = tandemLayout(projectRoot);
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, backupFile);
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, stateFile);
  return state;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLock(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

function isStale(lock) {
  if (!lock) return true;
  const age = lock.at ? Date.now() - Date.parse(lock.at) : Number.POSITIVE_INFINITY;
  return lock.pid === process.pid || !pidAlive(lock.pid) || age > LOCK_STALE_MS;
}

// Atomic: the lock file is created with "wx" (fails if it exists). A stale lock is removed once and the
// creation retried. Release only deletes the file if it still carries our token.
export function acquireLock(projectRoot) {
  const { root, lockFile } = tandemLayout(projectRoot);
  fs.mkdirSync(root, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      return () => {
        if (readLock(lockFile)?.token !== token) return;
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readLock(lockFile);
      if (!isStale(existing)) {
        throw new TandemError(
          "locked",
          `Another tandem command is running (pid ${existing.pid} since ${existing.at}).`,
          "Wait for it to finish, or delete .tandem/lock if that process is dead."
        );
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // raced with the owner; retry below
      }
    }
  }
  throw new TandemError("locked", "Could not acquire .tandem/lock.", "Retry in a moment.");
}

export async function withLock(projectRoot, fn) {
  const release = acquireLock(projectRoot);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function addUsage(state, kind, usage) {
  if (!usage) return state;
  state.usage.byKind[kind] ??= emptyUsage();
  for (const bucket of [state.usage.total, state.usage.session, state.usage.byKind[kind]]) {
    bucket.input += usage.input;
    bucket.output += usage.output;
    bucket.total += usage.total;
    bucket.runs += usage.runs ?? 1;
  }
  return state;
}
