import { TandemError } from "../lib/output.mjs";
import { ensureLayout } from "../lib/paths.mjs";
import { MODES, loadState, saveState, withLock } from "../lib/state.mjs";
import { cancelWorker, refreshWorkers, unfinishedWorkers } from "../lib/workers.mjs";

export async function runControl({ command, project, positionals, options }) {
  return withLock(project, async () => {
    const state = loadState(project);
    let cancelledWorkers = 0;
    let unresolvedWorkers = 0;
    let settledWorkers = 0;
    if (command === "mode") {
      const mode = positionals[0];
      if (!MODES.includes(mode)) throw new TandemError("bad_mode", `Unknown mode "${mode}".`, `Use one of: ${MODES.join(", ")}`);
      state.mode = mode;
    } else if (command === "pause") {
      state.paused = true;
    } else if (command === "unpause") {
      state.paused = false;
      state.stopped = false;
    } else if (command === "stop") {
      state.paused = true;
      state.stopped = true;
      const layout = ensureLayout(project);
      await refreshWorkers(state, { project, layout }); // finished workers keep their results
      for (const worker of unfinishedWorkers(state)) {
        const outcome = await cancelWorker(state, worker, { project, layout });
        if (!outcome.gone) unresolvedWorkers += 1;
        else if (worker.status === "cancelled") cancelledWorkers += 1;
        else settledWorkers += 1; // the process was already done: its report counts
      }
    } else if (command === "config") {
      if (options["min-remaining"] !== undefined) {
        const value = Number(options["min-remaining"]);
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new TandemError("bad_config", "--min-remaining must be between 0 and 100.");
        state.config = { ...(state.config ?? {}), minRemainingPercent: value };
      }
    }
    saveState(project, state);
    return { mode: state.mode, paused: state.paused, stopped: state.stopped, config: state.config, cancelledWorkers, unresolvedWorkers, settledWorkers };
  });
}
