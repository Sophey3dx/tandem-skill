import { codexVersion, loginStatus, resolveCodex } from "../lib/codex.mjs";
import { isUnderTemp } from "../lib/paths.mjs";
import { readRateLimits } from "../lib/ratelimits.mjs";
import { loadState, saveState, stateExists, withLock } from "../lib/state.mjs";

export async function runDoctor({ project }) {
  let codex = null;
  let codexError = null;
  try {
    const resolved = resolveCodex();
    codex = { cmd: resolved.cmd, prefix: resolved.prefix, version: codexVersion(), login: loginStatus() };
  } catch (error) {
    codexError = error.message;
  }
  const rateLimits = codex ? await readRateLimits() : null;
  const projectInTemp = isUnderTemp(project);
  const started = stateExists(project);
  let versionChanged = null;
  if (started && codex?.version) {
    // Load-modify-save under the same lock every other writer uses.
    await withLock(project, async () => {
      const state = loadState(project);
      if (state.codexVersion && state.codexVersion !== codex.version) versionChanged = { from: state.codexVersion, to: codex.version };
      state.codexVersion = codex.version;
      state.rateLimits = rateLimits;
      saveState(project, state);
    });
  }
  const hints = [];
  if (!codex) hints.push("Install Codex: npm install -g @openai/codex (or set TANDEM_CODEX_BIN).");
  if (codex && !codex.login.loggedIn) hints.push("Run `codex login`.");
  if (projectInTemp) hints.push("Project lies under TEMP: workspace-write sandboxes cannot confine workers here. Move it.");
  if (versionChanged) hints.push(`Codex version changed ${versionChanged.from} → ${versionChanged.to}: run a low-effort checkpoint as smoke test.`);
  if (rateLimits?.error) hints.push(`Rate limits unknown (${rateLimits.error}); the guard will not block.`);
  return {
    ready: Boolean(codex?.version && codex?.login?.loggedIn),
    node: process.version,
    codex,
    codexError,
    project,
    projectInTemp,
    started,
    rateLimits,
    versionChanged,
    hints
  };
}
