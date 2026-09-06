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

// Archives are written as <name>.pending.md first and only renamed into place after a valid verdict, so a
// failed re-run never overwrites the last archived (possibly approved) version. A source that already IS the
// archive file is left alone (self-copy fails on Windows).
function stageArchive(sourceFile, targetFile) {
  if (canonical(sourceFile) === canonical(targetFile)) return null;
  const pending = targetFile.replace(/\.md$/, ".pending.md");
  fs.copyFileSync(sourceFile, pending);
  return pending;
}

function commitArchives(staged) {
  for (const { pending, target } of staged) {
    if (pending) fs.renameSync(pending, target);
  }
}

function discardArchives(staged) {
  for (const { pending } of staged) {
    if (pending && fs.existsSync(pending)) fs.unlinkSync(pending);
  }
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
    const staged = [];
    const planTarget = path.join(layout.plans, `plan-r${round}.md`);
    staged.push({ pending: stageArchive(planFile, planTarget), target: planTarget });
    let matrixBlock = "";
    if (matrixFile) {
      const matrixTarget = path.join(layout.plans, `matrix-r${round}.md`);
      staged.push({ pending: stageArchive(matrixFile, matrixTarget), target: matrixTarget });
      matrixBlock = renderTemplate("plan-matrix", { PREVIOUS: String(round - 1), MATRIX: fs.readFileSync(matrixFile, "utf8") });
    }
    const n = state.contacts + 1;
    const contactId = `C${n}`;
    const base = `${stamp(n)}-plan-r${round}`;
    const wrapped = path.join(layout.prompts, `${base}.md`);
    fs.writeFileSync(wrapped, renderTemplate("plan-round", { ROUND: String(round), PLAN_HASH: hash, PLAN: plan, MATRIX_BLOCK: matrixBlock }), "utf8");
    const outFile = path.join(layout.replies, `${base}.json`);
    let exchange;
    try {
      exchange = await runWithSchema({
        state, project, layout, base, n, contactId, promptFile: wrapped, schema: "plan-verdict", effort, deadlineMs, outFile, kind: "plan", idPrefix: `P${round}`, round, options
      });
    } catch (error) {
      discardArchives(staged);
      throw error;
    }
    const { result, parsed, errors, attempts } = exchange;
    state.contacts = n;
    state.lastContact = { id: contactId, kind: `plan-r${round}`, at: new Date().toISOString(), status: parsed ? "ok" : "invalid_output", replyPath: outFile, durationMs: result.durationMs, effort };
    if (parsed) {
      commitArchives(staged);
      nextPlan.hash = hash;
      nextPlan.round = round;
      nextPlan.planFile = planFile;
      nextPlan.verdicts.push({ round, hash, verdict: parsed.verdict, consensus: isConsensus(parsed), blockersOpen: parsed.criteria.blockersOpen, points: parsed.points.length, pointIds: parsed.points.map((p) => `${p.id}:${p.severity}`), replyPath: outFile });
      state.plan = nextPlan;
    } else {
      discardArchives(staged);
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
