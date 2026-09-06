import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildResumeArgs, failureToError, minutes, normalizeEffort, runCodex, threadIdFromEvents } from "../lib/codex.mjs";
import { checkBudgetOrRecord, noteFailure, recordFailedContact, retryPromptFile } from "../lib/exchange.mjs";
import { TandemError } from "../lib/output.mjs";
import { ensureLayout, stamp } from "../lib/paths.mjs";
import { renderTemplate } from "../lib/prompts.mjs";
import { parseReplyFile, schemaPath } from "../lib/schema.mjs";
import { addUsage, loadState, saveState, withLock } from "../lib/state.mjs";
import { extractUsage } from "../lib/usage.mjs";

// `codex exec review` ignores --output-schema (verified 2026-09-06: its final message is prose), so the
// final review runs as a fresh `codex exec` thread with an explicit review contract and the verdict schema.
// The thread reads the real diff itself (read-only sandbox, git available). A schema-invalid answer gets
// exactly one retry by resuming that review thread, like contacts and plan rounds.

function describeTarget(options) {
  if (options.base) return { flag: ["--base", String(options.base)], label: `Branch gegen ${options.base}`, diffCommand: `git diff ${options.base}...HEAD`, statArgs: ["diff", "--stat", `${options.base}...HEAD`] };
  if (options.commit) return { flag: ["--commit", String(options.commit)], label: `Commit ${options.commit}`, diffCommand: `git show ${options.commit}`, statArgs: ["show", "--stat", "--format=%h %s", String(options.commit)] };
  return { flag: ["--uncommitted"], label: "uncommittete Änderungen", diffCommand: "git status --short --untracked-files=all && git diff && git diff --cached", statArgs: ["diff", "--stat", "HEAD"] };
}

function gitStat(project, statArgs) {
  const result = spawnSync("git", ["-C", project, ...statArgs], { encoding: "utf8", windowsHide: true });
  const text = String(result.stdout ?? "").trim();
  if (result.status !== 0 || !text) return "(kein git --stat verfügbar)";
  const lines = text.split(/\r?\n/);
  return lines.length > 60 ? `${lines.slice(0, 60).join("\n")}\n… (${lines.length - 60} weitere Zeilen)` : text;
}

export async function runReview({ project, options }) {
  if (!fs.existsSync(path.join(project, ".git"))) {
    throw new TandemError("not_git", "review needs a git repository.", "Use `contact --kind final` with a file list and diff excerpt instead.");
  }
  const target = describeTarget(options);
  const effort = normalizeEffort(options.effort ?? "medium");
  const timeoutMs = minutes(options["deadline-min"] ?? 15);
  return withLock(project, async () => {
    const state = loadState(project);
    const layout = ensureLayout(project);
    const n = state.contacts + 1;
    const contactId = `C${n}`;
    const base = `${stamp(n)}-review`;
    const outFile = path.join(layout.replies, `${base}.json`);
    const schema = schemaPath("verdict");
    const promptFile = path.join(layout.prompts, `${base}.md`);
    fs.writeFileSync(
      promptFile,
      renderTemplate("review", {
        TARGET: target.label,
        TITLE_SUFFIX: options.title ? ` („${String(options.title)}")` : "",
        DIFF_COMMAND: target.diffCommand,
        STAT: gitStat(project, target.statArgs)
      }),
      "utf8"
    );
    let reviewThreadId = null;
    let attempts = 0;
    let result = null;
    let parsed = null;
    let errors = [];
    while (attempts < 2) {
      attempts += 1;
      await checkBudgetOrRecord(state, { project, options, previous: result, n, contactId, kind: "review", outFile, effort }); // before every model call
      const retry = attempts > 1;
      const args = retry
        ? buildResumeArgs({ threadId: reviewThreadId, effort, schemaPath: schema, outFile })
        : ["exec", "--json", "-C", project, "-s", "read-only", "--skip-git-repo-check", "-c", `model_reasoning_effort=${effort}`, "--output-schema", schema, "-o", outFile, "-"];
      const currentPrompt = retry ? retryPromptFile(layout, base, "verdict", errors) : promptFile;
      result = await runCodex({ args, promptFile: currentPrompt, cwd: project, timeoutMs, logFile: path.join(layout.replies, `${base}${retry ? "-retry" : ""}.log`) });
      addUsage(state, "review", extractUsage(result));
      if (result.failure) {
        noteFailure(state, result);
        recordFailedContact(state, { n, contactId, kind: "review", outFile, effort, result });
        saveState(project, state);
        throw failureToError(result, "review");
      }
      reviewThreadId = reviewThreadId ?? threadIdFromEvents(result.events);
      ({ parsed, errors } = parseReplyFile(outFile, "verdict", { idPrefix: "R" }));
      if (parsed || !reviewThreadId) break; // without a thread id there is nothing to resume
    }
    state.contacts = n;
    state.lastContact = { id: contactId, kind: "review", at: new Date().toISOString(), status: parsed ? "ok" : "invalid_output", replyPath: outFile, durationMs: result.durationMs, effort, reviewThreadId };
    saveState(project, state);
    if (!parsed) {
      throw new TandemError("invalid_output", `Codex review did not match schema after ${attempts} attempts: ${errors.join("; ")}`, "Read the reply file; rerun review once if it looks like a transient glitch.", { replyPath: outFile, contactId });
    }
    return { contactId, kind: "review", target: target.flag.join(" "), verdict: parsed, replyPath: outFile, reviewThreadId, durationMs: result.durationMs, attempts, rateLimits: state.rateLimits };
  });
}
