import fs from "node:fs";
import path from "node:path";
import { minutes, normalizeEffort } from "../lib/codex.mjs";
import { guardActive, runWithSchema } from "../lib/exchange.mjs";
import { TandemError } from "../lib/output.mjs";
import { ensureLayout, requireAbsolute, stamp } from "../lib/paths.mjs";
import { renderTemplate } from "../lib/prompts.mjs";
import { emptyUsage, loadState, saveState, withLock } from "../lib/state.mjs";

export const KINDS = {
  checkpoint: { schema: "verdict", effort: "low", deadline: 5 },
  resume: { schema: "verdict", effort: "low", deadline: 5 },
  final: { schema: "verdict", effort: "medium", deadline: 8 }
};

const CAPS = {
  verdict: "Maximal 5 Punkte, nach Schwere sortiert, nur was jetzt zählt.",
  sparring: "Kurz und konkret: maximal 8 Einträge je Liste."
};

export async function runContact({ project, options }) {
  const kind = String(options.kind ?? "");
  if (!KINDS[kind]) {
    throw new TandemError("bad_kind", `Unknown --kind "${kind}".`, `Use one of: ${Object.keys(KINDS).join(", ")} (sparring folgt in Plan B).`);
  }
  const promptFile = requireAbsolute(options["prompt-file"], "--prompt-file");
  const spec = KINDS[kind];
  const effort = normalizeEffort(options.effort ?? spec.effort);
  const deadlineMs = minutes(options["deadline-min"] ?? spec.deadline);
  return withLock(project, async () => {
    const state = loadState(project);
    guardActive(state, options);
    const layout = ensureLayout(project);
    const n = state.contacts + 1;
    const contactId = `C${n}`;
    const base = `${stamp(n)}-${kind}`;
    const body = fs.readFileSync(promptFile, "utf8");
    const wrapped = path.join(layout.prompts, `${base}.md`);
    fs.writeFileSync(wrapped, renderTemplate("contact", { CONTACT_ID: contactId, KIND: kind, BODY: body, SCHEMA: spec.schema, CAP: CAPS[spec.schema] }), "utf8");
    const outFile = path.join(layout.replies, `${base}.json`);
    if (kind === "resume") state.usage.session = emptyUsage(); // new session starts WITH this contact
    const { result, parsed, errors, attempts } = await runWithSchema({
      state, project, layout, base, n, contactId, promptFile: wrapped, schema: spec.schema, effort, deadlineMs, outFile, kind, idPrefix: contactId, options
    });
    state.contacts = n;
    state.lastContact = { id: contactId, kind, at: new Date().toISOString(), status: parsed ? "ok" : "invalid_output", replyPath: outFile, durationMs: result.durationMs, effort };
    saveState(project, state);
    if (!parsed) {
      throw new TandemError(
        "invalid_output",
        `Codex answer did not match schema ${spec.schema} after ${attempts} attempts: ${errors.join("; ")}`,
        "Read the reply file and decide manually, or rerun the contact.",
        { replyPath: outFile, contactId }
      );
    }
    return { contactId, kind, verdict: parsed, replyPath: outFile, durationMs: result.durationMs, usage: state.usage.session, attempts, rateLimits: state.rateLimits };
  });
}
