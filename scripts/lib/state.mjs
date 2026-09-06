import fs from "node:fs";
import { TandemError } from "./output.mjs";
import { tandemLayout } from "./paths.mjs";

export const STATE_VERSION = 1;
export const MODES = ["begleiter", "plan", "sparring", "split"];
export const LOCK_STALE_MS = 30 * 60 * 1000;
// A held lock is refreshed on this interval so long Codex calls never age into "stale" while alive.
export const LOCK_HEARTBEAT_MS = Number(process.env.TANDEM_LOCK_HEARTBEAT_MS ?? 60 * 1000);
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

// The lock this process currently holds (one at a time per runner invocation). saveState refuses to write
// when the lock file no longer carries our token: a holder that lost its lock (e.g. after a long suspend)
// must not clobber the state of the process that took over.
let heldLock = null;

export function saveState(projectRoot, state) {
  const { root, stateFile, backupFile, lockFile } = tandemLayout(projectRoot);
  if (heldLock && heldLock.lockFile === lockFile && readLock(lockFile)?.token !== heldLock.token) {
    throw new TandemError("lock_lost", "This command lost the .tandem/lock to another process; state was not saved.", "Re-run the command. If it happens repeatedly, check for a runaway tandem process.");
  }
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, backupFile);
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, stateFile);
  return state;
}

export function pidAlive(pid) {
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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// An unreadable lock (missing, empty, half-written) is re-read once after a short pause before it counts as
// stale; only a lock that stays unreadable is treated as garbage.
function inspectLock(lockFile) {
  const first = readLock(lockFile);
  if (first) return first;
  sleepSync(50);
  return readLock(lockFile);
}

function lockAgeMs(lockFile, lock) {
  // The heartbeat only touches the inode's mtime; the JSON content is immutable. Fall back to `at` when the
  // file vanished between read and stat.
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs;
  } catch {
    return lock?.at ? Date.now() - Date.parse(lock.at) : Number.POSITIVE_INFINITY;
  }
}

function isStale(lockFile, lock) {
  if (!lock) return true;
  return lock.pid === process.pid || !pidAlive(lock.pid) || lockAgeMs(lockFile, lock) > LOCK_STALE_MS;
}

// Atomic: the lock file is created with "wx" (fails if it exists) and its content never changes afterwards.
// The creator keeps the file descriptor open; the heartbeat only touches the mtime of THAT inode
// (futimes), so a lock that was replaced by another process (new inode at the same path) can never be
// overwritten by the old holder. Staleness = pid dead, or mtime older than LOCK_STALE_MS (recycled pids,
// suspended holders). A stale lock is removed only while it still holds exactly the content that was
// inspected, then the creation is retried. Release only deletes the file if it still carries our token.
export function acquireLock(projectRoot) {
  const { root, lockFile } = tandemLayout(projectRoot);
  fs.mkdirSync(root, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          fs.futimesSync(fd, now, now); // our inode only; harmless if the path was taken over
        } catch {
          // best effort; the next beat retries
        }
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      heldLock = { lockFile, token };
      let released = false;
      return () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        if (heldLock?.token === token) heldLock = null;
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
        if (readLock(lockFile)?.token !== token) return;
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      if (error.code !== "EEXIST") throw error;
      const existing = inspectLock(lockFile);
      if (!isStale(lockFile, existing)) {
        throw new TandemError(
          "locked",
          `Another tandem command is running (pid ${existing.pid} since ${existing.at}).`,
          "Wait for it to finish, or delete .tandem/lock if that process is dead."
        );
      }
      const current = readLock(lockFile);
      if (JSON.stringify(current) !== JSON.stringify(existing)) continue; // replaced meanwhile: re-inspect
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
