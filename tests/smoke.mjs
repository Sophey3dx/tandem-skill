#!/usr/bin/env node
// Runs doctor → start → checkpoint contact → status against the REAL codex CLI (low effort). Costs tokens. Opt-in only.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = process.argv[2];
if (!project || !path.isAbsolute(project)) {
  console.error("usage: node tests/smoke.mjs <absolute throwaway project dir outside TEMP>");
  process.exit(1);
}
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "tandem.mjs");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, "index.js"), "export function add(a, b) { return a + b; }\n", "utf8");
const summary = path.join(project, "summary.md");
fs.writeFileSync(summary, "Wegwerf-Projekt für einen tandem-Smoke-Test: eine Datei index.js mit add(a, b).", "utf8");

function run(args) {
  const env = { ...process.env };
  delete env.TANDEM_CODEX_BIN;
  const result = spawnSync(process.execPath, [runner, ...args], { cwd: project, encoding: "utf8", env });
  const line = (result.stdout || "").trim().split(/\r?\n/).pop() ?? "";
  console.log(args[0], "→", line.slice(0, 400));
  try {
    return JSON.parse(line);
  } catch {
    console.error(result.stderr);
    process.exit(1);
  }
}

const doctor = run(["doctor"]);
if (!doctor.ready) process.exit(1);
run(["start", "--summary-file", summary, "--effort", "low"]);
const prompt = path.join(project, "delta.md");
fs.writeFileSync(prompt, "## Baseline\nfrisch\n## Geänderte Pfade\n- index.js\n## Delta\nadd(a, b) neu.\n## Testbelege\nkeine\n## Einwände-Matrix\nkeine\n## Prüffrage\nFehlt ein Typ-Check?\n", "utf8");
const contact = run(["contact", "--kind", "checkpoint", "--prompt-file", prompt, "--effort", "low"]);
if (!contact.ok) process.exit(1);
run(["status", "--human"]);
