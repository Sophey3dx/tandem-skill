import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { minutes, normalizeEffort } from "../lib/codex.mjs";
import { guardActive, runWithSchema } from "../lib/exchange.mjs";
import { TandemError } from "../lib/output.mjs";
import { canonical, ensureLayout, requireAbsolute, stamp } from "../lib/paths.mjs";
import { renderTemplate } from "../lib/prompts.mjs";
import { loadState, saveState, withLock } from "../lib/state.mjs";

export function isConsensus(verdict) {
  return (
    verdict.verdict === "APPROVE" &&
    verdict.criteria.blockersOpen === 0 &&
    verdict.criteria.sourcesRead === true &&
    verdict.criteria.testStrategyFeasible === true &&
    String(verdict.criteria.residualRisk ?? "").trim().length > 0 &&
    !verdict.points.some((p) => p.severity === "BLOCKER" || p.severity === "MAJOR")
  );
}

// Copies a plan/matrix file into .tandem/plans unless it already IS that file (self-copy fails on Windows).
function archiveInto(sourceFile, targetFile) {
  if (canonical(sourceFile) === canonical(targetFile)) return;
  fs.copyFileSync(sourceFile, targetFile);
}

export async function runPlanRound({ project, options }) {
  const round = Number(options.round);
  if (![1, 2, 3].includes(round)) {
    throw new TandemError("bad_round", "--round must be 1, 2 or 3.", "Nach Runde 3 ohne Konsens entscheidet der Nutzer (beide Positionen vorlegen).");
  }
  const planFile = requireAbsolute(options["plan-file"], "--plan-file");
  const matrixFile = options["matrix-file"] ? requireAbsolute(options["matrix-file"], "--matrix-file") : null;
  if (round > 1 && !matrixFile) {
    throw new TandemError("matrix_required", "Rounds 2 and 3 require --matrix-file.", "Write the objection matrix (ID → accepted/rejected/deferred + reason) to a file.");
  }
  const effort = normalizeEffort(options.effort ?? (round === 1 ? "high" : "medium"));
  const deadlineMs = minutes(options["deadline-min"] ?? (round === 1 ? 15 : 10));
  return withLock(project, async () => {
    const state = loadState(project);
    guardActive(state, options);
    if (round > 1 && state.plan.round !== round - 1) {
      throw new TandemError("round_order", `Expected round ${state.plan.round + 1}, got ${round}.`, "Rounds run 1 → 2 → 3. Start a new plan with --round 1.");
    }
    // The plan state is only replaced after a successful verdict; a failed or invalid round leaves the last good state.
    const nextPlan = round === 1 ? { hash: null, round: 0, planFile: null, verdicts: [] } : structuredClone(state.plan);
    const layout = ensureLayout(project);
    const plan = fs.readFileSync(planFile, "utf8");
    const hash = crypto.createHash("sha256").update(plan).digest("hex").slice(0, 12);
    archiveInto(planFile, path.join(layout.plans, `plan-r${round}.md`));
    let matrixBlock = "";
    if (matrixFile) {
      archiveInto(matrixFile, path.join(layout.plans, `matrix-r${round}.md`));
      matrixBlock = renderTemplate("plan-matrix", { PREVIOUS: String(round - 1), MATRIX: fs.readFileSync(matrixFile, "utf8") });
    }
    const n = state.contacts + 1;
    const contactId = `C${n}`;
    const base = `${stamp(n)}-plan-r${round}`;
    const wrapped = path.join(layout.prompts, `${base}.md`);
    fs.writeFileSync(wrapped, renderTemplate("plan-round", { ROUND: String(round), PLAN_HASH: hash, PLAN: plan, MATRIX_BLOCK: matrixBlock }), "utf8");
    const outFile = path.join(layout.replies, `${base}.json`);
    const { result, parsed, errors, attempts } = await runWithSchema({
      state, project, layout, base, n, contactId, promptFile: wrapped, schema: "plan-verdict", effort, deadlineMs, outFile, kind: "plan", options
    });
    state.contacts = n;
    state.lastContact = { id: contactId, kind: `plan-r${round}`, at: new Date().toISOString(), status: parsed ? "ok" : "invalid_output", replyPath: outFile, durationMs: result.durationMs, effort };
    if (parsed) {
      nextPlan.hash = hash;
      nextPlan.round = round;
      nextPlan.planFile = planFile;
      nextPlan.verdicts.push({ round, hash, verdict: parsed.verdict, consensus: isConsensus(parsed), blockersOpen: parsed.criteria.blockersOpen, points: parsed.points.length, replyPath: outFile });
      state.plan = nextPlan;
    }
    saveState(project, state);
    if (!parsed) {
      throw new TandemError("invalid_output", `Codex plan verdict did not match schema after ${attempts} attempts: ${errors.join("; ")}`, "Read the reply file and decide manually, or rerun the round.", { replyPath: outFile, contactId });
    }
    return {
      contactId, round, planHash: hash, verdict: parsed, consensus: isConsensus(parsed), roundsLeft: 3 - round,
      replyPath: outFile, durationMs: result.durationMs, attempts, rateLimits: state.rateLimits
    };
  });
}
