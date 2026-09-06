import fs from "node:fs";
import path from "node:path";
import { failureToError, minutes, normalizeEffort, runCodex } from "../lib/codex.mjs";
import { checkBudgetOrRecord, guardActive, noteFailure, recordFailedContact } from "../lib/exchange.mjs";
import { TandemError } from "../lib/output.mjs";
import { ensureLayout, requireAbsolute, stamp } from "../lib/paths.mjs";
import { renderTemplate } from "../lib/prompts.mjs";
import { parseReplyFile, schemaPath } from "../lib/schema.mjs";
import { addUsage, loadState, saveState, withLock } from "../lib/state.mjs";
import { extractUsage } from "../lib/usage.mjs";

export const LANE_KINDS = {
  gegenposition: "Gegenposition: Argumentiere so stark wie möglich gegen Claudes aktuelle Position, mit konkreten Belegen aus dem Projekt. Keine Höflichkeitsformeln, keine Zugeständnisse ohne Grund.",
  premortem: "Premortem: Nimm an, das Vorhaben ist in sechs Monaten gescheitert. Erzähle rückwärts, woran es lag, wahrscheinlichste Ursachen zuerst, jede mit dem Frühindikator, an dem man sie rechtzeitig erkannt hätte.",
  alternative: "Alternative: Entwirf den einfachsten anderen Weg, der dasselbe Ziel erreicht, und vergleiche ihn ehrlich mit dem aktuellen Weg: Aufwand, Risiko, Reversibilität."
};

// A lane is an ephemeral fork of the tandem thread: it inherits the memory, its answer never enters the thread.
export function buildLaneArgs({ threadId, effort, outFile }) {
  return [
    "exec", "fork", threadId, "--ephemeral", "--skip-git-repo-check", "--json",
    "-c", "sandbox_mode=read-only", "-c", `model_reasoning_effort=${effort}`,
    "--output-schema", schemaPath("sparring"), "-o", outFile, "-"
  ];
}

export async function runLane({ project, options }) {
  const kind = String(options.kind ?? "");
  if (!LANE_KINDS[kind]) throw new TandemError("bad_kind", `Unknown lane --kind "${kind}".`, `Use one of: ${Object.keys(LANE_KINDS).join(", ")}`);
  const promptFile = requireAbsolute(options["prompt-file"], "--prompt-file");
  const effort = normalizeEffort(options.effort ?? "medium");
  const deadlineMs = minutes(options["deadline-min"] ?? 8);
  return withLock(project, async () => {
    const state = loadState(project);
    guardActive(state, options);
    const layout = ensureLayout(project);
    const n = state.contacts + 1;
    const contactId = `C${n}`;
    const base = `${stamp(n)}-lane-${kind}`;
    const prompt = renderTemplate("lane", { CONTACT_ID: contactId, KIND: kind, INSTRUCTION: LANE_KINDS[kind], BODY: fs.readFileSync(promptFile, "utf8") });
    const wrapped = path.join(layout.prompts, `${base}.md`);
    fs.writeFileSync(wrapped, prompt, "utf8");
    const outFile = path.join(layout.replies, `${base}.json`);
    const args = buildLaneArgs({ threadId: state.threadId, effort, outFile });
    let attempts = 0;
    let result = null;
    let parsed = null;
    let errors = [];
    let currentPrompt = wrapped;
    while (attempts < 2) {
      attempts += 1;
      await checkBudgetOrRecord(state, { project, options, previous: result, n, contactId, kind: "lane", outFile, effort });
      result = await runCodex({ args, promptFile: currentPrompt, cwd: project, timeoutMs: deadlineMs, logFile: path.join(layout.replies, `${base}${attempts > 1 ? "-retry" : ""}.log`) });
      addUsage(state, "lane", extractUsage(result));
      if (result.failure) {
        noteFailure(state, result);
        recordFailedContact(state, { n, contactId, kind: "lane", outFile, effort, result });
        saveState(project, state);
        throw failureToError(result, "lane");
      }
      ({ parsed, errors } = parseReplyFile(outFile, "sparring"));
      if (parsed) break;
      // Nothing to resume (ephemeral): fork again with the schema note in front of the full prompt.
      currentPrompt = path.join(layout.prompts, `${base}-retry.md`);
      fs.writeFileSync(currentPrompt, `Deine letzte Antwort auf die folgende Lane war nicht schema-konform (${errors.join("; ")}). Antworte ausschließlich als JSON nach dem Schema sparring, ohne Text davor oder danach.\n\n${prompt}`, "utf8");
    }
    state.contacts = n;
    state.lastContact = { id: contactId, kind: "lane", laneKind: kind, at: new Date().toISOString(), status: parsed ? "ok" : "invalid_output", replyPath: outFile, durationMs: result.durationMs, effort };
    saveState(project, state);
    if (!parsed) {
      throw new TandemError("invalid_output", `Lane answer did not match schema sparring after ${attempts} attempts: ${errors.join("; ")}`, "Read the reply file and decide manually, or rerun the lane.", { replyPath: outFile, contactId });
    }
    return { contactId, kind: "lane", laneKind: kind, answer: parsed, replyPath: outFile, durationMs: result.durationMs, attempts, rateLimits: state.rateLimits };
  });
}
