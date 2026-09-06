import { ensureLayout, tandemLayout } from "../lib/paths.mjs";
import { loadState, saveState, withLock } from "../lib/state.mjs";
import { ACTIVE_STATUSES, activeZones, refreshWorkers, workerView } from "../lib/workers.mjs";

function pct(window) {
  return window ? `${window.remainingPercent} % übrig (Reset ${window.resetsAt ?? "unbekannt"})` : "unbekannt";
}

export function renderHuman(summary) {
  const open = summary.workers.filter((w) => ACTIVE_STATUSES.has(w.status) || w.status === "retry_pending");
  const pending = open.filter((w) => w.status === "retry_pending").length;
  const lines = [
    `tandem ${summary.stopped ? "gestoppt" : summary.paused ? "pausiert" : "aktiv"} · Modus ${summary.mode} · Thread ${summary.threadId ?? "keiner"}`,
    `Kontakte: ${summary.contacts} · letzter: ${summary.lastContact ? `${summary.lastContact.id} ${summary.lastContact.kind} (${summary.lastContact.status})` : "keiner"}`,
    `Plan: Runde ${summary.plan.round}${summary.plan.lastVerdict ? ` · ${summary.plan.lastVerdict.verdict}${summary.plan.lastVerdict.consensus ? " (Konsens)" : ""}` : ""}`,
    `Tokens: gesamt ${summary.usage.total.total} · Session ${summary.usage.session.total}`,
    `Restnutzung: 5h ${pct(summary.rateLimits?.primary)} · Woche ${pct(summary.rateLimits?.secondary)} · Schwelle ${summary.config.minRemainingPercent} %`,
    `Worker aktiv: ${summary.activeWorkers} · ausstehende Retries: ${pending}${open.length ? ` (${open.map((w) => `${w.id} ${w.status} ${w.zone}`).join(", ")})` : ""} · Codex ${summary.codexVersion ?? "?"}`
  ];
  return lines.join("\n");
}

export async function runStatus({ project, options }) {
  return withLock(project, async () => {
    const state = loadState(project);
    const layout = ensureLayout(project);
    if (await refreshWorkers(state, { project, layout })) saveState(project, state);
    const summary = {
      project,
      threadId: state.threadId,
      threadStartedAt: state.threadStartedAt,
      mode: state.mode,
      paused: state.paused,
      stopped: state.stopped,
      contacts: state.contacts,
      lastContact: state.lastContact,
      plan: { hash: state.plan.hash, round: state.plan.round, lastVerdict: state.plan.verdicts.at(-1) ?? null },
      workers: (state.workers ?? []).map(workerView),
      activeWorkers: activeZones(state).length,
      pendingRetries: (state.workers ?? []).filter((w) => w.status === "retry_pending").length,
      server: state.server,
      usage: state.usage,
      rateLimits: state.rateLimits,
      config: state.config,
      codexVersion: state.codexVersion,
      threadHistory: state.threadHistory.length,
      ledger: tandemLayout(project).ledgerFile
    };
    if (options.human) summary.human = renderHuman(summary);
    return summary;
  });
}
