import fs from "node:fs";
import path from "node:path";
import { buildResumeArgs, failureToError, runCodex } from "./codex.mjs";
import { TandemError } from "./output.mjs";
import { ensureBudget, minRemainingOf } from "./ratelimits.mjs";
import { parseReplyFile, schemaPath } from "./schema.mjs";
import { addUsage, saveState } from "./state.mjs";
import { extractUsage } from "./usage.mjs";

export function guardActive(state, options = {}) {
  if (!state.threadId) throw new TandemError("not_started", "No tandem thread yet.", "Run `start --summary-file <abs>` first.");
  if (state.stopped && !options.force) throw new TandemError("stopped", "tandem is stopped for this project.", "Run `unpause` to continue or `start --force` for a fresh start.");
  if (state.paused && !options.force) throw new TandemError("paused", "tandem is paused.", "Run `unpause`, or pass --force for a single contact.");
}

export function noteFailure(state, result) {
  if (result.failure === "quota") state.paused = true;
}

// A failed contact still consumes its number so the next attempt gets a fresh id and fresh files.
export function recordFailedContact(state, { n, contactId, kind, outFile, effort, result }) {
  state.contacts = n;
  state.lastContact = {
    id: contactId, kind, at: new Date().toISOString(), status: result.failure, replyPath: outFile,
    durationMs: result.durationMs, effort
  };
}

// Budget check before a model call. If a previous attempt already ran (retry path), a refusal still books the
// contact so its id and files are not reused by the next command.
export async function checkBudgetOrRecord(state, { project, options, previous, n, contactId, kind, outFile, effort }) {
  try {
    await ensureBudget(state, { minRemaining: minRemainingOf(options) });
  } catch (error) {
    if (previous) recordFailedContact(state, { n, contactId, kind, outFile, effort, result: { failure: error.code ?? "quota_low", durationMs: previous.durationMs } });
    saveState(project, state);
    throw error;
  }
}

export function retryPromptFile(layout, base, schema, errors) {
  const file = path.join(layout.prompts, `${base}-retry.md`);
  fs.writeFileSync(
    file,
    `Deine letzte Antwort war nicht schema-konform (${errors.join("; ")}). Antworte jetzt erneut, ausschließlich als JSON nach dem Schema ${schema}, ohne Text davor oder danach.\n`,
    "utf8"
  );
  return file;
}

export async function runWithSchema({ state, project, layout, base, n, contactId, promptFile, schema, effort, deadlineMs, outFile, kind, idPrefix, round, options = {} }) {
  const args = buildResumeArgs({ threadId: state.threadId, effort, schemaPath: schemaPath(schema), outFile });
  let attempts = 0;
  let result = null;
  let parsed = null;
  let errors = [];
  let currentPrompt = promptFile;
  while (attempts < 2) {
    attempts += 1;
    await checkBudgetOrRecord(state, { project, options, previous: result, n, contactId, kind, outFile, effort }); // before EVERY model call
    result = await runCodex({
      args,
      promptFile: currentPrompt,
      cwd: project,
      timeoutMs: deadlineMs,
      logFile: path.join(layout.replies, `${base}${attempts > 1 ? "-retry" : ""}.log`)
    });
    addUsage(state, kind, extractUsage(result));
    if (result.failure) {
      noteFailure(state, result);
      recordFailedContact(state, { n, contactId, kind, outFile, effort, result });
      saveState(project, state);
      throw failureToError(result, kind);
    }
    ({ parsed, errors } = parseReplyFile(outFile, schema, { idPrefix, round }));
    if (parsed) break;
    currentPrompt = retryPromptFile(layout, base, schema, errors);
  }
  return { result, parsed, errors, attempts };
}
