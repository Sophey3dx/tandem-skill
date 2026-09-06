import fs from "node:fs";
import path from "node:path";
import { buildStartArgs, failureToError, minutes, normalizeEffort, readLastMessage, runCodex, threadIdFromEvents } from "../lib/codex.mjs";
import { recordFailedContact } from "../lib/exchange.mjs";
import { TandemError } from "../lib/output.mjs";
import { ensureLayout, requireAbsolute, stamp } from "../lib/paths.mjs";
import { renderTemplate } from "../lib/prompts.mjs";
import { ensureBudget, minRemainingOf } from "../lib/ratelimits.mjs";
import { addUsage, loadState, saveState, withLock } from "../lib/state.mjs";
import { extractUsage } from "../lib/usage.mjs";

const EXTRA = "Hinweis: Dies ist die Fortsetzung eines früheren Tandem-Threads. Die Zusammenfassung oben stammt aus dem Ledger von Claude und ersetzt das Gedächtnis des alten Threads.";

export async function runRotate({ project, options }) {
  const seedFile = requireAbsolute(options["seed-file"], "--seed-file");
  const effort = normalizeEffort(options.effort ?? "medium");
  const timeoutMs = minutes(options["deadline-min"] ?? 8);
  const reason = String(options.reason ?? "manual");
  return withLock(project, async () => {
    const state = loadState(project);
    if (!state.threadId) throw new TandemError("not_started", "No tandem thread to rotate.", "Run `start` first.");
    try {
      await ensureBudget(state, { minRemaining: minRemainingOf(options) });
    } catch (error) {
      saveState(project, state);
      throw error;
    }
    const layout = ensureLayout(project);
    const n = state.contacts + 1;
    const base = `${stamp(n)}-rotate`;
    const promptFile = path.join(layout.prompts, `${base}.md`);
    fs.writeFileSync(promptFile, renderTemplate("onboarding", { PROJECT_SUMMARY: fs.readFileSync(seedFile, "utf8"), EXTRA }), "utf8");
    const outFile = path.join(layout.replies, `${base}.md`);
    const result = await runCodex({ args: buildStartArgs({ project, effort, outFile }), promptFile, cwd: project, timeoutMs, logFile: path.join(layout.replies, `${base}.log`) });
    addUsage(state, "rotate", extractUsage(result));
    if (result.failure) {
      recordFailedContact(state, { n, contactId: `C${n}`, kind: "rotate", outFile, effort, result });
      saveState(project, state);
      throw failureToError(result, "rotate");
    }
    const threadId = threadIdFromEvents(result.events);
    if (!threadId) throw new TandemError("no_thread_id", "Codex did not report a thread id.", `Check ${base}.log.`);
    const previousThreadId = state.threadId;
    state.threadHistory.push({ threadId: previousThreadId, from: state.threadStartedAt, to: new Date().toISOString(), reason, contacts: state.contacts });
    state.threadId = threadId;
    state.threadStartedAt = new Date().toISOString();
    state.contacts = n;
    state.lastContact = { id: `C${n}`, kind: "rotate", at: state.threadStartedAt, status: "ok", replyPath: outFile, durationMs: result.durationMs, effort };
    state.paused = false;
    state.stopped = false;
    saveState(project, state);
    return { threadId, previousThreadId, replyPath: outFile, reply: readLastMessage(outFile), durationMs: result.durationMs, rateLimits: state.rateLimits };
  });
}
