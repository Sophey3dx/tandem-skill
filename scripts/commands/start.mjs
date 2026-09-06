import fs from "node:fs";
import path from "node:path";
import {
  buildStartArgs, codexVersion, failureToError, minutes, normalizeEffort, readLastMessage, runCodex, threadIdFromEvents
} from "../lib/codex.mjs";
import { TandemError } from "../lib/output.mjs";
import { ensureGitignoreEntry, ensureLayout, requireAbsolute, today } from "../lib/paths.mjs";
import { renderTemplate } from "../lib/prompts.mjs";
import { ensureBudget, minRemainingOf } from "../lib/ratelimits.mjs";
import { addUsage, defaultState, loadState, saveState, stateExists, withLock } from "../lib/state.mjs";
import { extractUsage } from "../lib/usage.mjs";

export async function runStart({ project, options }) {
  const summaryFile = requireAbsolute(options["summary-file"], "--summary-file");
  const effort = normalizeEffort(options.effort ?? "medium");
  const timeoutMs = minutes(options["deadline-min"] ?? 8);
  const layout = ensureLayout(project);
  return withLock(project, async () => {
    // Checked under the lock so two concurrent starts cannot both pass.
    if (stateExists(project) && loadState(project).threadId && !options.force) {
      throw new TandemError(
        "already_started",
        "tandem is already started in this project.",
        "Use `contact --kind resume` to continue, `rotate --seed-file <abs>` for a new thread, or `start --force` to reset."
      );
    }
    const state = defaultState(project);
    if (stateExists(project) && options.force) {
      const previous = loadState(project);
      state.config = previous.config ?? state.config;
      state.threadHistory = previous.threadId
        ? [...(previous.threadHistory ?? []), { threadId: previous.threadId, from: previous.threadStartedAt, to: new Date().toISOString(), reason: "start --force", contacts: previous.contacts }]
        : previous.threadHistory ?? [];
    }
    await ensureBudget(state, { minRemaining: minRemainingOf(options) });
    const summary = fs.readFileSync(summaryFile, "utf8");
    const promptFile = path.join(layout.prompts, "0000-start.md");
    fs.writeFileSync(promptFile, renderTemplate("onboarding", { PROJECT_SUMMARY: summary, EXTRA: "" }), "utf8");
    const outFile = path.join(layout.replies, "0000-start.md");
    const result = await runCodex({
      args: buildStartArgs({ project, effort, outFile }),
      promptFile,
      cwd: project,
      timeoutMs,
      logFile: path.join(layout.replies, "0000-start.log")
    });
    if (result.failure) throw failureToError(result, "start");
    const threadId = threadIdFromEvents(result.events);
    if (!threadId) {
      throw new TandemError("no_thread_id", "Codex did not report a thread id.", "Check .tandem/replies/0000-start.log.");
    }
    state.threadId = threadId;
    state.threadStartedAt = new Date().toISOString();
    state.codexVersion = codexVersion();
    addUsage(state, "start", extractUsage(result));
    if (!fs.existsSync(layout.ledgerFile)) {
      fs.writeFileSync(layout.ledgerFile, renderTemplate("ledger-template", { PROJECT: project, DATE: today() }), "utf8");
    }
    ensureGitignoreEntry(project, ".tandem/");
    saveState(project, state);
    return {
      threadId,
      replyPath: outFile,
      reply: readLastMessage(outFile),
      usage: state.usage.total,
      durationMs: result.durationMs,
      rateLimits: state.rateLimits
    };
  });
}
