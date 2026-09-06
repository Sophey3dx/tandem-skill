import { tandemLayout } from "../lib/paths.mjs";
import { loadState } from "../lib/state.mjs";

function pct(window) {
  return window ? `${window.remainingPercent} % übrig (Reset ${window.resetsAt ?? "unbekannt"})` : "unbekannt";
}

export function renderHuman(summary) {
  const lines = [
    `tandem ${summary.stopped ? "gestoppt" : summary.paused ? "pausiert" : "aktiv"} · Modus ${summary.mode} · Thread ${summary.threadId ?? "keiner"}`,
    `Kontakte: ${summary.contacts} · letzter: ${summary.lastContact ? `${summary.lastContact.id} ${summary.lastContact.kind} (${summary.lastContact.status})` : "keiner"}`,
    `Plan: Runde ${summary.plan.round}${summary.plan.lastVerdict ? ` · ${summary.plan.lastVerdict.verdict}${summary.plan.lastVerdict.consensus ? " (Konsens)" : ""}` : ""}`,
    `Tokens: gesamt ${summary.usage.total.total} · Session ${summary.usage.session.total}`,
    `Restnutzung: 5h ${pct(summary.rateLimits?.primary)} · Woche ${pct(summary.rateLimits?.secondary)} · Schwelle ${summary.config.minRemainingPercent} %`,
    `Worker aktiv: ${summary.workers.length} · Codex ${summary.codexVersion ?? "?"}`
  ];
  return lines.join("\n");
}

export async function runStatus({ project, options }) {
  const state = loadState(project);
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
    workers: state.workers,
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
}
