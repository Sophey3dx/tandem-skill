#!/usr/bin/env node
// Lane + worker against the REAL codex CLI (low effort). Usage: node tests/smoke-workers.mjs <absolute project outside TEMP>
// Exit code is non-zero when the lane fails, the worker does not finish DONE, the zone content is wrong,
// or the sandbox let the worker write outside its zone.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = process.argv[2];
if (!project || !path.isAbsolute(project)) {
  console.error("usage: node tests/smoke-workers.mjs <absolute throwaway project dir outside TEMP>");
  process.exit(1);
}
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "tandem.mjs");
const zone = path.join(project, "zone");
fs.mkdirSync(zone, { recursive: true });
fs.writeFileSync(path.join(project, "index.js"), "export function add(a, b) { return a + b; }\n", "utf8");
for (const leftover of [path.join(project, "leak.txt"), path.join(zone, "hello.txt")]) fs.rmSync(leftover, { force: true });

function fail(message) {
  console.error(`SMOKE FAILED: ${message}`);
  process.exit(1);
}

function run(args) {
  const env = { ...process.env };
  delete env.TANDEM_CODEX_BIN;
  const result = spawnSync(process.execPath, [runner, ...args], { cwd: project, encoding: "utf8", env });
  const line = (result.stdout || "").trim().split(/\r?\n/).pop() ?? "";
  console.log(args.slice(0, 2).join(" "), "→", line.slice(0, 500));
  try {
    return JSON.parse(line);
  } catch {
    fail(`runner produced no JSON: ${result.stderr}`);
  }
}

if (!fs.existsSync(path.join(project, ".tandem", "state.json"))) {
  const summary = path.join(project, "summary.md");
  fs.writeFileSync(summary, "Wegwerf-Projekt für den tandem-Smoke-Test (Plan B): index.js mit add(a, b), Ordner zone/ für einen Worker.", "utf8");
  if (!run(["start", "--summary-file", summary, "--effort", "low"]).ok) fail("start failed");
}
const topic = path.join(project, "topic.md");
fs.writeFileSync(topic, "Sollte add(a, b) Typen prüfen oder JavaScript-Koerzion zulassen? Kontext: winzige Bibliothek ohne Nutzer.", "utf8");
const lane = run(["lane", "--kind", "premortem", "--prompt-file", topic, "--effort", "low"]);
if (!lane.ok || !lane.answer?.position) fail("lane did not return a valid sparring answer");

const brief = path.join(project, "brief.md");
fs.writeFileSync(brief, [
  "## Auftragstyp", "Tests — warum Codex: abgegrenzt, in der Zone prüfbar.",
  "## Baseline", "frisch",
  "## Ziel", "Lege in der Zone eine Datei hello.txt mit exakt dem Inhalt hello (ohne Zeilenumbruch) an.",
  "## Nicht-Ziele", "Keine anderen Dateien in der Zone.",
  "## Erlaubte Dateien", "- hello.txt",
  "## Schnittstellen", "keine",
  "## Akzeptanztests", "- hello.txt existiert und enthält exakt hello",
  "- Sandbox-Probe (ausdrücklich erlaubt und Pflichtteil dieses Auftrags): führe den Befehl `node -e \"require('fs').writeFileSync('../leak.txt','leak')\"` in der Zone aus. Erwartung: er schlägt fehl. Trage genau diesen Befehl mit seinem Exitcode in `tests` ein und zitiere die Fehlermeldung in `notes`. Melde DONE nur, wenn die Probe fehlgeschlagen ist.",
  "## Löschrechte", "keine",
  "## Stop-Bedingungen", "Bei Unklarheit BLOCKED.",
  "## Kontext aus dem Ledger", "Wegwerf-Projekt, keine Konventionen."
].join("\n"), "utf8");
const started = run(["worker", "start", "--zone", zone, "--brief-file", brief, "--effort", "low", "--deadline-min", "5"]);
if (!started.ok) fail("worker start failed");
const waited = run(["worker", "wait", started.worker.id, "--poll-sec", "3"]);
if (!waited.ok || waited.worker.status !== "done") fail(`worker ended as ${waited.worker?.status}`);
const helloPath = path.join(zone, "hello.txt");
if (!fs.existsSync(helloPath) || !fs.readFileSync(helloPath).equals(Buffer.from("hello"))) fail("zone content is not exactly the bytes 'hello'");
const zoneEntries = fs.readdirSync(zone).sort();
if (zoneEntries.join(",") !== "hello.txt") fail(`zone contains unexpected entries: ${zoneEntries.join(", ")}`);
if (fs.existsSync(path.join(project, "leak.txt"))) fail("sandbox leak: ../leak.txt was written outside the zone");
const probe = (waited.worker.result.tests ?? []).find((t) => /leak\.txt/.test(t.cmd));
if (!probe) fail("the worker did not run the sandbox probe (no leak.txt command in tests)");
if (probe.exitCode === 0) fail(`the sandbox probe succeeded (exit 0): ${probe.cmd}`);
if (!/denied|EPERM|EACCES|blocked|verweigert|fehlgeschlagen|failed|error/i.test(waited.worker.result.notes ?? "")) fail(`notes do not describe the blocked probe: ${waited.worker.result.notes}`);
console.log("probe:", probe.cmd, "→ exit", probe.exitCode);
console.log("SMOKE OK: lane answered, worker DONE, zone content exact, probe blocked, no leak outside the zone");
