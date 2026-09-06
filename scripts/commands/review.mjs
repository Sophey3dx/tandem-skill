import fs from "node:fs";
import path from "node:path";
import { failureToError, minutes, normalizeEffort, runCodex } from "../lib/codex.mjs";
import { noteFailure, recordFailedContact } from "../lib/exchange.mjs";
import { TandemError } from "../lib/output.mjs";
import { ensureLayout, stamp } from "../lib/paths.mjs";
import { ensureBudget, minRemainingOf } from "../lib/ratelimits.mjs";
import { parseReplyFile, schemaPath } from "../lib/schema.mjs";
import { addUsage, loadState, saveState, withLock } from "../lib/state.mjs";
import { extractUsage } from "../lib/usage.mjs";

export async function runReview({ project, options }) {
  if (!fs.existsSync(path.join(project, ".git"))) {
    throw new TandemError("not_git", "review needs a git repository.", "Use `contact --kind final` with a file list and diff excerpt instead.");
  }
  const target = options.base ? ["--base", String(options.base)] : options.commit ? ["--commit", String(options.commit)] : ["--uncommitted"];
  const effort = normalizeEffort(options.effort ?? "medium");
  const timeoutMs = minutes(options["deadline-min"] ?? 15);
  return withLock(project, async () => {
    const state = loadState(project);
    try {
      await ensureBudget(state, { minRemaining: minRemainingOf(options) });
    } catch (error) {
      saveState(project, state);
      throw error;
    }
    const layout = ensureLayout(project);
    const n = state.contacts + 1;
    const contactId = `C${n}`;
    const base = `${stamp(n)}-review`;
    const outFile = path.join(layout.replies, `${base}.json`);
    const args = [
      "exec", "review", ...target, "--skip-git-repo-check", "--json",
      "-c", "sandbox_mode=read-only", "-c", `model_reasoning_effort=${effort}`,
      "--output-schema", schemaPath("verdict"), "-o", outFile
    ];
    if (options.title) args.push("--title", String(options.title));
    const result = await runCodex({ args, promptFile: null, cwd: project, timeoutMs, logFile: path.join(layout.replies, `${base}.log`) });
    addUsage(state, "review", extractUsage(result));
    if (result.failure) {
      noteFailure(state, result);
      recordFailedContact(state, { n, contactId, kind: "review", outFile, effort, result });
      saveState(project, state);
      throw failureToError(result, "review");
    }
    const { parsed, errors } = parseReplyFile(outFile, "verdict");
    state.contacts = n;
    state.lastContact = { id: contactId, kind: "review", at: new Date().toISOString(), status: parsed ? "ok" : "invalid_output", replyPath: outFile, durationMs: result.durationMs, effort };
    saveState(project, state);
    if (!parsed) {
      throw new TandemError("invalid_output", `Codex review did not match schema: ${errors.join("; ")}`, "Read the reply file; rerun review once if it looks like a transient glitch.", { replyPath: outFile, contactId });
    }
    return { contactId, kind: "review", target: target.join(" "), verdict: parsed, replyPath: outFile, durationMs: result.durationMs, rateLimits: state.rateLimits };
  });
}
