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

const REF_PATTERN = /^[A-Za-z0-9._/@^~{}-]+$/;

// Resolve the review target with git BEFORE spending a model call: an unknown ref would otherwise yield a
// diff-less "OK". Uncommitted reviews need at least one commit (HEAD) to diff against. Only the resolved
// commit hash is ever placed into the prompt (a ref can move, and ref names may carry shell metacharacters).
function verifyTarget(project, options) {
  const ref = options.base ? String(options.base) : options.commit ? String(options.commit) : "HEAD";
  if (!REF_PATTERN.test(ref)) {
    throw new TandemError("bad_ref", `Ref "${ref}" contains characters that are not allowed.`, "Use a plain branch, tag or commit name.");
  }
  const result = spawnSync("git", ["-C", project, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8", windowsHide: true });
  const hash = String(result.stdout ?? "").trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(hash)) {
    throw new TandemError("bad_ref", `git cannot resolve "${ref}" in ${project}.`, options.base || options.commit ? "Pass an existing branch, tag or commit." : "The repository needs at least one commit before an uncommitted review.");
  }
  return hash;
}

function describeTarget(options, hash) {
  const chosen = ["base", "commit", "uncommitted"].filter((key) => options[key] !== undefined && options[key] !== false);
  if (chosen.length > 1) {
    throw new TandemError("bad_target", `Use exactly one of --uncommitted, --base <ref>, --commit <sha> (got ${chosen.map((k) => `--${k}`).join(", ")}).`);
  }
  if (options.base) return { flag: ["--base", String(options.base)], label: `Branch gegen ${options.base} (${hash.slice(0, 12)})`, diffCommand: `git diff ${hash}...HEAD`, statArgs: ["diff", "--stat", `${hash}...HEAD`] };
  if (options.commit) return { flag: ["--commit", String(options.commit)], label: `Commit ${hash.slice(0, 12)}`, diffCommand: `git show ${hash}`, statArgs: ["show", "--stat", "--format=%h %s", hash] };
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
  const chosen = ["base", "commit", "uncommitted"].filter((key) => options[key] !== undefined && options[key] !== false);
  if (chosen.length > 1) {
    throw new TandemError("bad_target", `Use exactly one of --uncommitted, --base <ref>, --commit <sha> (got ${chosen.map((k) => `--${k}`).join(", ")}).`);
  }
  const resolvedRef = verifyTarget(project, options);
  const target = describeTarget(options, resolvedRef);
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
    return { contactId, kind: "review", target: target.flag.join(" "), resolvedRef, verdict: parsed, replyPath: outFile, reviewThreadId, durationMs: result.durationMs, attempts, rateLimits: state.rateLimits };
  });
}
