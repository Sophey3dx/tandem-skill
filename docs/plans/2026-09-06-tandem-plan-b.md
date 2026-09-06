# Tandem Plan B (Worker, Zonen, Sparring, Lanes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arbeitsteilung (Codex-Worker mit sandbox-erzwungenen Schreib-Zonen, detached, mit Deadline und strukturierter Rückgabe), Sparring-Kontakte auf dem Dauer-Thread und Fork-Lanes (Gegenposition, Premortem, Alternative) — auf dem Runner-Kern aus Plan A.

**Architecture:** Zwei neue Schemas (`worker-result`, `sparring`) mit semantischen Regeln; ein Zonen-Prüfer (`lib/zones.mjs`), der Zonen gegen Projekt, TEMP, `.tandem/`, Build-/Cache-Ordner, Reparse Points und aktive Zonen prüft; eine Worker-Bibliothek (`lib/workers.mjs`), die Codex detached mit stdin-Brief und Log-Datei startet, Zustände aktualisiert (done/partial/blocked/timeout/orphaned/failed/cancelled) und Usage aus dem Log verbucht; Befehle `worker start|status|wait|cancel`, `lane`, `contact --kind sparring`; `status` und `stop` kennen Worker.

**Tech Stack:** wie Plan A (Node ≥ 18.18, ESM, `node:test`, Fake-Codex, Codex CLI 0.153: `codex exec -C <zone> -s workspace-write`, `codex exec fork <id> --ephemeral`). Windows-Sandbox „unelevated" (verifiziert: Zone beschreibbar, außerhalb blockiert, sofern nicht unter `%TEMP%`).

## Global Constraints

- Spec: `docs/2026-09-06-tandem-design.md` (Abschnitte 4.3, 4.4, 5, 6, 7, 8, 9, 10). Bei Widerspruch gilt die Spec.
- Arbeitsverzeichnis für **alle** Befehle: `C:\Users\david\.claude\skills\tandem`, Branch `feat/plan-b` von `main`.
- Alle Konventionen aus Plan A gelten weiter: eine JSON-Zeile pro Runner-Aufruf, absolute Pfade, Prompts per stdin/Datei, strict Schemas + semantische Prüfung, Wächter vor jedem Modellaufruf, fehlgeschlagene Kontakte werden verbucht, Lock über `withLock`.
- **Nur Worker** laufen mit `workspace-write`, und nur mit `-C <zone>`; der Tandem-Thread und Lanes bleiben `read-only`. Nie `--dangerously-bypass-approvals-and-sandbox`.
- Zonen: absolut, im Projekt, nicht Projekt-Root, nicht unter `%TEMP%`/`%TMP%`, existent, nicht unter `.tandem/` (Ausnahme `.tandem/design/…`), kein Segment und kein Inhalt aus `node_modules|dist|build|.next|target|.git`, keine Reparse Points, keine Überlappung mit aktiven Zonen, max. **2** aktive Worker.
- Worker-Brief (von Claude) muss die Überschriften `Ziel`, `Nicht-Ziele`, `Erlaubte Dateien`, `Akzeptanztests`, `Stop-Bedingungen` enthalten; der Runner hängt den Vertrag an.
- Sprache: Skill-Texte/Vorlagen Deutsch, Code/Commits Englisch. Commit-Messages enden mit `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Tests nur unter `tests/.tmp/`, nie unter `%TEMP%` (außer dem expliziten TEMP-Ablehnungstest, der danach aufräumt).

---

## Dateistruktur (Plan B)

| Datei | Verantwortung |
|-------|---------------|
| `references/schemas/worker-result.schema.json` | Worker-Rückgabe (strict) |
| `references/schemas/sparring.schema.json` | Sparring-/Lane-Antwort (strict) |
| `references/templates/worker-contract.md` | Vertrag, den der Runner an Claudes Brief anhängt |
| `references/templates/lane.md` | Lane-Prompt (Fork) |
| `scripts/lib/schema.mjs` | + zwei Schemas, semantische Regeln für sparring/worker-result |
| `scripts/lib/zones.mjs` | `checkZone`, `FORBIDDEN_DIR_NAMES`, `MAX_ACTIVE_WORKERS` |
| `scripts/lib/workers.mjs` | detached Start, Argumente, Brief-Prüfung, Refresh, Usage-Buchung, Cancel, Views |
| `scripts/lib/state.mjs` | `pidAlive` exportieren |
| `scripts/commands/worker.mjs` | `worker start\|status\|wait\|cancel` |
| `scripts/commands/lane.mjs` | `lane --kind gegenposition\|premortem\|alternative` |
| `scripts/commands/contact.mjs` | `--kind sparring` |
| `scripts/commands/status.mjs` | Worker-Refresh unter Lock, Worker-Sicht |
| `scripts/commands/control.mjs` | `stop` bricht aktive Worker ab |
| `scripts/tandem.mjs` | Befehle `worker`, `lane` registrieren |
| `tests/fake-codex.mjs` | Samples für worker-result/sparring, `FAKE_WORKER_STATUS`, `FAKE_WORKER_WRITE`, `FAKE_SPARRING_EMPTY` |
| `tests/zones.test.mjs`, `tests/worker.test.mjs`, `tests/lane.test.mjs` | neue Tests; `schema`, `status`, `contact` erweitert |
| `tests/smoke-workers.mjs` | Opt-in Smoke gegen echtes Codex: Lane + Worker |
| `SKILL.md`, `references/contracts.md`, `README.md`, Spec | Doku |

---

### Task 1: Schemas `worker-result` und `sparring`, semantische Regeln, Fake-Samples

**Files:**
- Create: `references/schemas/worker-result.schema.json`, `references/schemas/sparring.schema.json`
- Modify: `scripts/lib/schema.mjs` (SCHEMA_NAMES, semanticErrors)
- Modify: `tests/fake-codex.mjs` (sampleFor, `FAKE_WORKER_STATUS`, `FAKE_WORKER_WRITE`, `FAKE_SPARRING_EMPTY`)
- Test: `tests/schema.test.mjs`

**Interfaces:**
- Produces: `SCHEMA_NAMES = ["verdict","plan-verdict","worker-result","sparring"]`; `semanticErrors("sparring"|"worker-result", value)`; `parseReplyFile(file, "worker-result"|"sparring")`.
- worker-result: `{ status: DONE|PARTIAL|BLOCKED, touchedFiles: string[], tests: [{cmd, exitCode:int}], remaining: string[], blockers: [{text, evidence}], notes: string }`. Regeln: DONE ⇒ `remaining` und `blockers` leer; BLOCKED ⇒ ≥ 1 blocker; PARTIAL ⇒ `remaining` ≥ 1.
- sparring: `{ position, reasons: string[], checked: string[], risks: string[], recommendation }`. Regeln: `position` und `recommendation` nicht leer; `reasons`, `risks` ≤ 8.
- Fake: `FAKE_WORKER_STATUS=DONE|PARTIAL|BLOCKED` (Default DONE), `FAKE_WORKER_WRITE=1` schreibt `ok.txt` in den `-C`-Ordner, `FAKE_SPARRING_EMPTY=1` liefert leere `position`.

- [ ] **Step 1: Schemas anlegen**

`references/schemas/worker-result.schema.json`:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "touchedFiles", "tests", "remaining", "blockers", "notes"],
  "properties": {
    "status": { "type": "string", "enum": ["DONE", "PARTIAL", "BLOCKED"] },
    "touchedFiles": { "type": "array", "items": { "type": "string" } },
    "tests": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["cmd", "exitCode"],
        "properties": { "cmd": { "type": "string" }, "exitCode": { "type": "integer" } }
      }
    },
    "remaining": { "type": "array", "items": { "type": "string" } },
    "blockers": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["text", "evidence"],
        "properties": { "text": { "type": "string" }, "evidence": { "type": "string" } }
      }
    },
    "notes": { "type": "string" }
  }
}
```

`references/schemas/sparring.schema.json`:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["position", "reasons", "checked", "risks", "recommendation"],
  "properties": {
    "position": { "type": "string" },
    "reasons": { "type": "array", "items": { "type": "string" } },
    "checked": { "type": "array", "items": { "type": "string" } },
    "risks": { "type": "array", "items": { "type": "string" } },
    "recommendation": { "type": "string" }
  }
}
```

- [ ] **Step 2: Failing Test ergänzen** (`tests/schema.test.mjs`, ans Ende)

```js
test("sparring and worker-result semantics", () => {
  const good = { position: "p", reasons: ["a"], checked: [], risks: [], recommendation: "r" };
  assert.deepEqual(validate(loadSchema("sparring"), good), []);
  assert.deepEqual(semanticErrors("sparring", good), []);
  assert.ok(semanticErrors("sparring", { ...good, position: " " }).some((e) => e.includes("$.position")));
  assert.ok(semanticErrors("sparring", { ...good, recommendation: "" }).some((e) => e.includes("$.recommendation")));
  assert.ok(semanticErrors("sparring", { ...good, reasons: Array(9).fill("x") }).some((e) => e.includes("$.reasons: more than 8")));
  const done = { status: "DONE", touchedFiles: ["a.js"], tests: [{ cmd: "node --test", exitCode: 0 }], remaining: [], blockers: [], notes: "" };
  assert.deepEqual(validate(loadSchema("worker-result"), done), []);
  assert.deepEqual(semanticErrors("worker-result", done), []);
  assert.ok(semanticErrors("worker-result", { ...done, remaining: ["x"] }).some((e) => e.includes("DONE contradicts")));
  assert.ok(semanticErrors("worker-result", { ...done, status: "BLOCKED" }).some((e) => e.includes("BLOCKED requires")));
  assert.ok(semanticErrors("worker-result", { ...done, status: "PARTIAL" }).some((e) => e.includes("PARTIAL requires")));
  assert.deepEqual(semanticErrors("worker-result", { ...done, status: "BLOCKED", blockers: [{ text: "t", evidence: "e" }] }), []);
  assert.equal(schemaPath("worker-result").endsWith("worker-result.schema.json"), true);
});
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag prüfen**

Run: `node --test tests/schema.test.mjs`
Expected: FAIL mit `bad_schema` für `sparring`.

- [ ] **Step 4: schema.mjs erweitern**

`SCHEMA_NAMES`:
```js
export const SCHEMA_NAMES = ["verdict", "plan-verdict", "worker-result", "sparring"];
```

In `semanticErrors`, nach dem `plan-verdict`-Block, vor `return errors;`:
```js
  if (schemaName === "sparring") {
    if (!String(value?.position ?? "").trim()) errors.push("$.position: must not be empty");
    if (!String(value?.recommendation ?? "").trim()) errors.push("$.recommendation: must not be empty");
    for (const key of ["reasons", "risks"]) {
      if (Array.isArray(value?.[key]) && value[key].length > 8) errors.push(`$.${key}: more than 8 items`);
    }
  }
  if (schemaName === "worker-result") {
    const remaining = Array.isArray(value?.remaining) ? value.remaining : [];
    const blockers = Array.isArray(value?.blockers) ? value.blockers : [];
    if (value?.status === "DONE" && (remaining.length > 0 || blockers.length > 0)) errors.push("$.status: DONE contradicts remaining work or blockers");
    if (value?.status === "BLOCKED" && blockers.length === 0) errors.push("$.status: BLOCKED requires at least one blocker with evidence");
    if (value?.status === "PARTIAL" && remaining.length === 0) errors.push("$.status: PARTIAL requires remaining work");
  }
```

- [ ] **Step 5: Fake-Codex erweitern** (`tests/fake-codex.mjs`)

`import path from "node:path";` ergänzen. In `sampleFor(schema, stdin)` die letzten beiden Zweige ersetzen:
```js
  if (schema.properties?.status) {
    const status = process.env.FAKE_WORKER_STATUS ?? "DONE";
    const zone = opt("-C");
    if (zone && process.env.FAKE_WORKER_WRITE === "1") fs.writeFileSync(path.join(zone, "ok.txt"), "ok", "utf8");
    return {
      status,
      touchedFiles: ["ok.txt"],
      tests: [{ cmd: "node --test", exitCode: 0 }],
      remaining: status === "PARTIAL" ? ["rest of the task"] : [],
      blockers: status === "BLOCKED" ? [{ text: "fake blocker", evidence: "ok.txt:1" }] : [],
      notes: "fake worker"
    };
  }
  return {
    position: process.env.FAKE_SPARRING_EMPTY === "1" ? "" : "fake position",
    reasons: ["r1"],
    checked: ["src/a.js"],
    risks: ["risk"],
    recommendation: "do it"
  };
```

- [ ] **Step 6: Test laufen lassen, Erfolg prüfen**

Run: `node --test tests/schema.test.mjs`
Expected: `# pass 9`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add references/schemas/worker-result.schema.json references/schemas/sparring.schema.json scripts/lib/schema.mjs tests/fake-codex.mjs tests/schema.test.mjs
git commit -m "feat(runner): worker-result and sparring schemas with semantic rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Zonen-Prüfer (`lib/zones.mjs`)

**Files:**
- Create: `scripts/lib/zones.mjs`
- Test: `tests/zones.test.mjs`

**Interfaces:**
- Consumes: `canonical`, `isUnder`, `isUnderTemp`, `tandemLayout` (paths), `TandemError`.
- Produces: `FORBIDDEN_DIR_NAMES: Set`, `MAX_ACTIVE_WORKERS = 2`, `checkZone({ project, zone, activeZones = [] }) → resolvedZone` (wirft `bad_zone` mit `message` + `hint`).

- [ ] **Step 1: Failing Test schreiben** (`tests/zones.test.mjs`)

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_ACTIVE_WORKERS, checkZone } from "../scripts/lib/zones.mjs";
import { makeProject } from "./helpers.mjs";

function zoneIn(project, rel) {
  const dir = path.join(project, rel);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const code = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code;
  }
};

test("a plain sub-folder is accepted and returned resolved; max workers is 2", () => {
  const project = makeProject("zone-ok");
  const zone = zoneIn(project, "src/feature");
  assert.equal(checkZone({ project, zone }), path.resolve(zone));
  assert.equal(MAX_ACTIVE_WORKERS, 2);
});

test("relative, outside, root, missing and file zones are rejected", () => {
  const project = makeProject("zone-bad");
  assert.equal(code(() => checkZone({ project, zone: "src/feature" })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: project })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: path.resolve(project, "..") })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: path.join(project, "missing") })), "bad_zone");
  const file = path.join(project, "file.txt");
  fs.writeFileSync(file, "x");
  assert.equal(code(() => checkZone({ project, zone: file })), "bad_zone");
});

test("zones under TEMP are rejected", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-zone-"));
  const zone = zoneIn(project, "z");
  assert.equal(code(() => checkZone({ project, zone })), "bad_zone");
  fs.rmSync(project, { recursive: true, force: true });
});

test(".tandem is off limits except .tandem/design; shared folders are rejected as zone or inside it", () => {
  const project = makeProject("zone-forbidden");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".tandem/plans") })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".tandem") })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".tandem/design") })), "bad_zone");
  assert.equal(checkZone({ project, zone: zoneIn(project, ".tandem/design/1/codex") }), path.resolve(project, ".tandem/design/1/codex"));
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, "node_modules/pkg") })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, ".git/hooks") })), "bad_zone");
  const withCache = zoneIn(project, "app");
  zoneIn(project, "app/dist");
  assert.equal(code(() => checkZone({ project, zone: withCache })), "bad_zone");
});

test("reparse points (junctions/symlinks) inside the zone are rejected", () => {
  const project = makeProject("zone-link");
  const zone = zoneIn(project, "zone");
  const target = zoneIn(project, "elsewhere");
  fs.symlinkSync(target, path.join(zone, "link"), "junction");
  assert.equal(code(() => checkZone({ project, zone })), "bad_zone");
});

test("zones must not overlap active zones", () => {
  const project = makeProject("zone-overlap");
  const active = zoneIn(project, "a");
  assert.equal(code(() => checkZone({ project, zone: zoneIn(project, "a/sub"), activeZones: [active] })), "bad_zone");
  assert.equal(code(() => checkZone({ project, zone: active, activeZones: [active] })), "bad_zone");
  assert.equal(checkZone({ project, zone: zoneIn(project, "b"), activeZones: [active] }), path.resolve(project, "b"));
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `node --test tests/zones.test.mjs`
Expected: FAIL mit `Cannot find module` für `zones.mjs`.

- [ ] **Step 3: zones.mjs implementieren**

```js
import fs from "node:fs";
import path from "node:path";
import { TandemError } from "./output.mjs";
import { canonical, isUnder, isUnderTemp, tandemLayout } from "./paths.mjs";

export const FORBIDDEN_DIR_NAMES = new Set(["node_modules", "dist", "build", ".next", "target", ".git"]);
export const MAX_ACTIVE_WORKERS = 2;
const WALK_LIMIT = 20000;

function bad(message, hint = null) {
  return new TandemError("bad_zone", message, hint);
}

// Walks the zone: no reparse points (the sandbox cannot confine writes through them) and no shared
// build/cache/VCS folders inside.
function walk(root) {
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > WALK_LIMIT) throw bad(`Zone has more than ${WALK_LIMIT} entries: ${root}`, "Choose a smaller zone.");
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw bad(`Zone contains a symlink or junction: ${full}`, "Remove it or choose another zone.");
      if (entry.isDirectory()) {
        if (FORBIDDEN_DIR_NAMES.has(entry.name)) throw bad(`Zone contains a shared build/cache/VCS folder: ${full}`, "Workers must not touch node_modules, dist, build, .next, target or .git.");
        stack.push(full);
      }
    }
  }
}

export function checkZone({ project, zone, activeZones = [] }) {
  if (!zone || typeof zone !== "string" || !path.isAbsolute(zone)) throw bad(`Zone must be an absolute path, got: ${zone}`, "Pass an absolute folder inside the project.");
  const resolved = path.resolve(zone);
  const layout = tandemLayout(project);
  if (!isUnder(resolved, project) || canonical(resolved) === canonical(project)) throw bad(`Zone must lie inside the project and must not be the project root: ${resolved}`, "Choose a sub-folder of the project.");
  if (isUnderTemp(resolved)) throw bad(`Zone lies under a TEMP directory: ${resolved}`, "workspace-write sandboxes cannot confine writes under TEMP. Move the project.");
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw bad(`Zone does not exist: ${resolved}`, "Create the folder first.");
  }
  if (stat.isSymbolicLink()) throw bad(`Zone is a symlink or junction: ${resolved}`, "Use the real folder.");
  if (!stat.isDirectory()) throw bad(`Zone is not a directory: ${resolved}`);
  if (isUnder(resolved, layout.root)) {
    if (!isUnder(resolved, layout.design) || canonical(resolved) === canonical(layout.design)) {
      throw bad(`Zone must not lie inside .tandem/ (only design rounds under .tandem/design/<N>/ are allowed): ${resolved}`);
    }
  }
  for (const segment of path.relative(project, resolved).split(/[\\/]+/)) {
    if (FORBIDDEN_DIR_NAMES.has(segment)) throw bad(`Zone lies inside a shared build/cache/VCS folder (${segment}): ${resolved}`, "Zones must not touch node_modules, dist, build, .next, target or .git.");
  }
  for (const active of activeZones) {
    if (isUnder(resolved, active) || isUnder(active, resolved)) throw bad(`Zone overlaps an active worker zone: ${active}`, "Wait for that worker (`worker wait <id>`) or choose a disjoint folder.");
  }
  walk(resolved);
  return resolved;
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `node --test tests/zones.test.mjs`
Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/zones.mjs tests/zones.test.mjs
git commit -m "feat(runner): zone checks for sandboxed workers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Worker-Bibliothek und `worker start|status|wait|cancel`

**Files:**
- Modify: `scripts/lib/state.mjs` (`pidAlive` exportieren)
- Create: `scripts/lib/workers.mjs`
- Create: `references/templates/worker-contract.md`
- Create: `scripts/commands/worker.mjs`
- Modify: `scripts/tandem.mjs` (`worker` registrieren)
- Test: `tests/worker.test.mjs`

**Interfaces:**
- Consumes: `checkZone`, `MAX_ACTIVE_WORKERS` (Task 2), Schema `worker-result` (Task 1), `resolveCodex`, `killTree`, `parseJsonl`, `classifyFailure`, `minutes`, `normalizeEffort` (codex), `guardActive` (exchange), `ensureBudget`, `minRemainingOf` (ratelimits), `renderTemplate`, `loadState`, `saveState`, `withLock`, `addUsage`, `pidAlive` (state), `usageFromEvents`.
- Produces (workers.mjs): `TERMINAL_STATUSES: Set`, `REQUIRED_BRIEF_SECTIONS`, `missingBriefSections(brief) → string[]`, `buildWorkerArgs({ zone, effort, outFile })`, `spawnDetachedCodex({ args, stdinFile, logFile, cwd, env }) → { pid }`, `refreshWorkers(state, { now, env }) → boolean`, `bookWorkerUsage(state, worker)`, `cancelWorker(state, worker, env)`, `activeZones(state) → string[]`, `workerView(worker)`.
- Worker-Datensatz in `state.workers[]`: `{ id: "W<n>", zone, pid, effort, status, startedAt, deadlineAt, briefPath, resultPath, logPath, usageBooked, result?, errors?, failure?, finishedAt? }`; Zähler `state.workerSeq`.
- Befehl: `worker start --zone <abs> --brief-file <abs> [--effort medium] [--deadline-min 20] [--model <name>] [--min-remaining] [--force]` → `{ worker, activeWorkers }` (`--model` wird als `-m <name>` an Codex durchgereicht, nur für Worker; Zuteilung nach Stärken, siehe Spec 4.4); `worker status [id]` → `{ workers, active }`; `worker wait <id> [--poll-sec 5] [--timeout-min]` → `{ worker, waitedMs, timedOutWaiting? }`; `worker cancel <id>` → `{ worker }`.

- [ ] **Step 1: `pidAlive` exportieren** (`scripts/lib/state.mjs`)

`function pidAlive(pid) {` → `export function pidAlive(pid) {`

- [ ] **Step 2: Vertragsvorlage anlegen** (`references/templates/worker-contract.md`)

```markdown
---
## Tandem-Worker-Vertrag ({{WORKER_ID}}, vom Runner angehängt)

- Du arbeitest ausschließlich in der Zone `{{ZONE}}`. Die Sandbox erlaubt Schreiben nur dort; Schreibversuche außerhalb schlagen fehl und sind nicht erwünscht. Lesen darfst du das ganze Projekt.
- Kein `git commit`, kein `git push`, keine Änderungen an gemeinsamen Build- oder Cache-Ordnern, keine Paketinstallation.
- Halte dich an die erlaubten Dateien und die Stop-Bedingungen des Auftrags. Bei Unklarheit nicht raten, sondern BLOCKED melden und die Frage in `blockers` stellen.
- Führe die Akzeptanztests aus, soweit sie in der Zone laufen, und nenne Befehle mit Exitcodes.
- Antworte am Ende ausschließlich als JSON nach dem Schema worker-result, ohne Text davor oder danach: `status` DONE|PARTIAL|BLOCKED, `touchedFiles` (Pfade relativ zur Zone), `tests` [{cmd, exitCode}], `remaining`, `blockers` [{text, evidence}], `notes`. DONE nur ohne Restarbeit und ohne Blocker.
```

- [ ] **Step 3: Failing Test schreiben** (`tests/worker.test.mjs`)

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeProject, readLog, runTandem, startProject, writeFile } from "./helpers.mjs";

const BRIEF = [
  "# Auftrag W",
  "## Ziel", "Schreibe ok.txt mit dem Inhalt ok.",
  "## Nicht-Ziele", "Nichts anderes anfassen.",
  "## Erlaubte Dateien", "- ok.txt",
  "## Schnittstellen", "keine",
  "## Akzeptanztests", "- Datei existiert",
  "## Löschrechte", "keine",
  "## Stop-Bedingungen", "Bei Unklarheit BLOCKED."
].join("\n");

function prepared(name) {
  const dir = makeProject(name);
  startProject(dir);
  const zone = path.join(dir, "zone");
  fs.mkdirSync(zone);
  const brief = writeFile(dir, "brief.md", BRIEF);
  return { dir, zone, brief };
}

test("worker start validates brief and zone, spawns detached; wait returns DONE with usage booked", () => {
  const { dir, zone, brief } = prepared("worker-ok");
  const logFile = path.join(dir, "fake.log");
  const incomplete = writeFile(dir, "short.md", "## Ziel\nx\n");
  assert.equal(runTandem(["worker", "start", "--zone", zone, "--brief-file", incomplete], { cwd: dir }).json.error, "brief_incomplete");
  assert.equal(runTandem(["worker", "start", "--zone", path.join(dir, "missing"), "--brief-file", brief], { cwd: dir }).json.error, "bad_zone");
  const started = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_CODEX_LOG: logFile, FAKE_WORKER_WRITE: "1" } });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  assert.equal(started.json.worker.id, "W1");
  assert.equal(started.json.worker.status, "running");
  assert.equal(started.json.activeWorkers, 1);
  const waited = runTandem(["worker", "wait", "W1", "--poll-sec", "1"], { cwd: dir });
  assert.equal(waited.json.worker.status, "done", JSON.stringify(waited.json));
  assert.equal(waited.json.worker.result.status, "DONE");
  assert.equal(fs.readFileSync(path.join(zone, "ok.txt"), "utf8"), "ok");
  const call = readLog(logFile).find((c) => c.argv[0] === "exec");
  assert.ok(call.argv.includes("workspace-write"));
  assert.equal(call.argv[call.argv.indexOf("-C") + 1], zone);
  assert.ok(call.argv.includes("--output-schema"));
  assert.ok(call.stdin.includes("## Ziel"));
  assert.ok(call.stdin.includes("Tandem-Worker-Vertrag (W1"));
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8"));
  assert.equal(state.usage.byKind.worker.runs, 1);
  assert.equal(state.usage.byKind.worker.total, 120);
  assert.equal(state.workers[0].status, "done");
  assert.ok(fs.existsSync(path.join(dir, ".tandem", "workers", "W1", "brief.md")));
  assert.ok(fs.existsSync(path.join(dir, ".tandem", "workers", "W1", "log.txt")));
});

test("PARTIAL and BLOCKED results are reported; a hanging worker times out and is killed", () => {
  const { dir, zone, brief } = prepared("worker-states");
  const w1 = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_WORKER_STATUS: "BLOCKED" } });
  const blocked = runTandem(["worker", "wait", w1.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  assert.equal(blocked.json.worker.status, "blocked");
  assert.equal(blocked.json.worker.result.blockers[0].text, "fake blocker");
  const zone2 = path.join(dir, "zone2");
  fs.mkdirSync(zone2);
  const w2 = runTandem(["worker", "start", "--zone", zone2, "--brief-file", brief], { cwd: dir, env: { FAKE_WORKER_STATUS: "PARTIAL" } });
  assert.equal(runTandem(["worker", "wait", w2.json.worker.id, "--poll-sec", "1"], { cwd: dir }).json.worker.status, "partial");
  const zone3 = path.join(dir, "zone3");
  fs.mkdirSync(zone3);
  const w3 = runTandem(["worker", "start", "--zone", zone3, "--brief-file", brief, "--deadline-min", "0.05"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(w3.json.ok, true, JSON.stringify(w3.json));
  const waited = runTandem(["worker", "wait", w3.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  assert.equal(waited.json.worker.status, "timeout");
});

test("max two active workers, overlapping zones rejected, cancel kills, status counts", () => {
  const { dir, zone, brief } = prepared("worker-limit");
  const zoneB = path.join(dir, "zoneB");
  fs.mkdirSync(zoneB);
  const zoneC = path.join(dir, "zoneC");
  fs.mkdirSync(zoneC);
  const a = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  const b = runTandem(["worker", "start", "--zone", zoneB, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(a.json.ok, true);
  assert.equal(b.json.ok, true);
  assert.equal(runTandem(["worker", "start", "--zone", zoneC, "--brief-file", brief], { cwd: dir }).json.error, "too_many_workers");
  const nested = path.join(zoneB, "inner");
  fs.mkdirSync(nested);
  const cancelled = runTandem(["worker", "cancel", a.json.worker.id], { cwd: dir });
  assert.equal(cancelled.json.worker.status, "cancelled");
  assert.equal(runTandem(["worker", "start", "--zone", nested, "--brief-file", brief], { cwd: dir }).json.error, "bad_zone");
  runTandem(["worker", "cancel", b.json.worker.id], { cwd: dir });
  const status = runTandem(["worker", "status"], { cwd: dir });
  assert.equal(status.json.active, 0);
  assert.equal(status.json.workers.length, 2);
  assert.equal(runTandem(["worker", "status", "W9"], { cwd: dir }).json.error, "no_such_worker");
  assert.equal(runTandem(["worker", "dance"], { cwd: dir }).json.error, "bad_subcommand");
});

test("worker start is blocked by the budget guard and by stop", () => {
  const { dir, zone, brief } = prepared("worker-guard");
  assert.equal(runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir, env: { FAKE_USED_PRIMARY: "97" } }).json.error, "quota_low");
  runTandem(["stop"], { cwd: dir });
  assert.equal(runTandem(["worker", "start", "--zone", zone, "--brief-file", brief], { cwd: dir }).json.error, "stopped");
});

test("--model is passed through to the worker only, and validated", () => {
  const { dir, zone, brief } = prepared("worker-model");
  const logFile = path.join(dir, "fake.log");
  assert.equal(runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--model", "bad model;x"], { cwd: dir }).json.error, "bad_model");
  const started = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--model", "gpt-5.3-codex-spark"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  assert.equal(started.json.worker.model, "gpt-5.3-codex-spark");
  runTandem(["worker", "wait", started.json.worker.id, "--poll-sec", "1"], { cwd: dir });
  const call = readLog(logFile).find((c) => c.argv[0] === "exec");
  assert.equal(call.argv[call.argv.indexOf("-m") + 1], "gpt-5.3-codex-spark");
});
```

- [ ] **Step 4: Test laufen lassen, Fehlschlag prüfen**

Run: `node --test tests/worker.test.mjs`
Expected: FAIL mit `unknown_command` für `worker`.

- [ ] **Step 5: workers.mjs implementieren**

```js
import { spawn } from "node:child_process";
import fs from "node:fs";
import { classifyFailure, killTree, parseJsonl, resolveCodex } from "./codex.mjs";
import { TandemError } from "./output.mjs";
import { parseReplyFile, schemaPath } from "./schema.mjs";
import { addUsage, pidAlive } from "./state.mjs";
import { usageFromEvents } from "./usage.mjs";

export const TERMINAL_STATUSES = new Set(["done", "partial", "blocked", "timeout", "orphaned", "cancelled", "invalid_output", "failed"]);
export const REQUIRED_BRIEF_SECTIONS = ["Ziel", "Nicht-Ziele", "Erlaubte Dateien", "Akzeptanztests", "Stop-Bedingungen"];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function missingBriefSections(brief) {
  return REQUIRED_BRIEF_SECTIONS.filter((section) => !new RegExp(`^#{1,3}\\s*${escapeRegExp(section)}\\s*$`, "im").test(brief));
}

export function buildWorkerArgs({ zone, effort, outFile, model = null }) {
  return [
    "exec", "--json", "-C", zone, "-s", "workspace-write", "--skip-git-repo-check",
    ...(model ? ["-m", model] : []),
    "-c", `model_reasoning_effort=${effort}`, "--output-schema", schemaPath("worker-result"), "-o", outFile, "-"
  ];
}

function winQuote(arg) {
  const text = String(arg);
  return /[\s&|<>^()]/.test(text) ? `"${text}"` : text;
}

function shQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

// Starts codex detached: stdin from the brief file, stdout and stderr into the log file. The runner returns
// immediately; the process lives on. Windows: a cmd.exe wrapper performs the redirects and its pid heads the
// tree that `taskkill /T` kills. POSIX: `sh -c exec …`, so the pid IS codex and leads its own process group.
export function spawnDetachedCodex({ args, stdinFile, logFile, cwd, env = process.env }) {
  const { cmd, prefix } = resolveCodex(env);
  const full = [cmd, ...prefix, ...args];
  let child;
  if (process.platform === "win32") {
    for (const arg of [...full, stdinFile, logFile]) {
      if (String(arg).includes('"')) throw new TandemError("bad_path", `Double quotes are not allowed in worker paths: ${arg}`);
    }
    const line = `${full.map(winQuote).join(" ")} < ${winQuote(stdinFile)} > ${winQuote(logFile)} 2>&1`;
    child = spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { cwd, env, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
  } else {
    const line = `exec ${full.map(shQuote).join(" ")} < ${shQuote(stdinFile)} > ${shQuote(logFile)} 2>&1`;
    child = spawn("/bin/sh", ["-c", line], { cwd, env, detached: true, stdio: "ignore" });
  }
  child.unref();
  return { pid: child.pid };
}

function readLogText(logPath) {
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

export function bookWorkerUsage(state, worker) {
  if (worker.usageBooked) return;
  const usage = usageFromEvents(parseJsonl(readLogText(worker.logPath)));
  if (usage) addUsage(state, "worker", usage);
  worker.usageBooked = true;
}

function finish(state, worker, status, now, extra = {}) {
  Object.assign(worker, { status, finishedAt: new Date(now).toISOString(), ...extra });
  bookWorkerUsage(state, worker);
}

// Brings every non-terminal worker up to date. Returns true when something changed (the caller saves).
export function refreshWorkers(state, { now = Date.now(), env = process.env } = {}) {
  let changed = false;
  for (const worker of state.workers ?? []) {
    if (TERMINAL_STATUSES.has(worker.status)) continue;
    const alive = pidAlive(worker.pid);
    if (fs.existsSync(worker.resultPath)) {
      const { parsed, errors } = parseReplyFile(worker.resultPath, "worker-result");
      if (parsed) finish(state, worker, parsed.status.toLowerCase(), now, { result: parsed });
      else if (!alive) finish(state, worker, "invalid_output", now, { errors });
      else continue; // result still being written
    } else if (now > Date.parse(worker.deadlineAt)) {
      killTree(worker.pid, env);
      finish(state, worker, "timeout", now);
    } else if (!alive) {
      const failure = classifyFailure({ status: 1, timedOut: false, stderr: readLogText(worker.logPath) });
      finish(state, worker, failure === "codex_failed" ? "orphaned" : "failed", now, { failure });
    } else {
      continue;
    }
    changed = true;
  }
  return changed;
}

export function cancelWorker(state, worker, env = process.env) {
  if (TERMINAL_STATUSES.has(worker.status)) return false;
  killTree(worker.pid, env);
  finish(state, worker, "cancelled", Date.now());
  return true;
}

export function activeZones(state) {
  return (state.workers ?? []).filter((w) => !TERMINAL_STATUSES.has(w.status)).map((w) => w.zone);
}

export function workerView(worker) {
  const { usageBooked, ...view } = worker;
  return view;
}
```

- [ ] **Step 6: worker.mjs implementieren** (`scripts/commands/worker.mjs`)

```js
import fs from "node:fs";
import path from "node:path";
import { minutes, normalizeEffort } from "../lib/codex.mjs";
import { guardActive } from "../lib/exchange.mjs";
import { TandemError } from "../lib/output.mjs";
import { ensureLayout, requireAbsolute } from "../lib/paths.mjs";
import { renderTemplate } from "../lib/prompts.mjs";
import { ensureBudget, minRemainingOf } from "../lib/ratelimits.mjs";
import { loadState, saveState, withLock } from "../lib/state.mjs";
import {
  TERMINAL_STATUSES, activeZones, buildWorkerArgs, cancelWorker, missingBriefSections, refreshWorkers, spawnDetachedCodex, workerView
} from "../lib/workers.mjs";
import { MAX_ACTIVE_WORKERS, checkZone } from "../lib/zones.mjs";

const SUBCOMMANDS = ["start", "status", "wait", "cancel"];

function findWorker(state, id) {
  const worker = (state.workers ?? []).find((w) => w.id === id);
  if (!worker) throw new TandemError("no_such_worker", `Unknown worker "${id}".`, `Known: ${(state.workers ?? []).map((w) => w.id).join(", ") || "none"}`);
  return worker;
}

function requireId(positionals, verb) {
  const id = positionals[1];
  if (!id) throw new TandemError("bad_args", `worker ${verb} needs a worker id.`, `Example: worker ${verb} W1`);
  return id;
}

async function start({ project, options }) {
  const zoneArg = requireAbsolute(options.zone, "--zone");
  const briefFile = requireAbsolute(options["brief-file"], "--brief-file");
  const effort = normalizeEffort(options.effort ?? "medium");
  const deadlineMs = minutes(options["deadline-min"] ?? 20);
  const model = options.model === undefined ? null : String(options.model).trim();
  if (model !== null && !/^[A-Za-z0-9._-]+$/.test(model)) throw new TandemError("bad_model", `--model must be a plain model name, got "${options.model}".`);
  const brief = fs.readFileSync(briefFile, "utf8");
  const missing = missingBriefSections(brief);
  if (missing.length > 0) {
    throw new TandemError("brief_incomplete", `Worker brief lacks sections: ${missing.join(", ")}.`, "Add the headings ## Ziel, ## Nicht-Ziele, ## Erlaubte Dateien, ## Akzeptanztests, ## Stop-Bedingungen.");
  }
  return withLock(project, async () => {
    const state = loadState(project);
    guardActive(state, options);
    if (refreshWorkers(state)) saveState(project, state);
    const active = activeZones(state);
    if (active.length >= MAX_ACTIVE_WORKERS) {
      throw new TandemError("too_many_workers", `${active.length} workers are already active (max ${MAX_ACTIVE_WORKERS}).`, "Wait for one (`worker wait <id>`) or cancel it (`worker cancel <id>`).");
    }
    const zone = checkZone({ project, zone: zoneArg, activeZones: active });
    try {
      await ensureBudget(state, { minRemaining: minRemainingOf(options) });
    } catch (error) {
      saveState(project, state);
      throw error;
    }
    const layout = ensureLayout(project);
    state.workerSeq = (state.workerSeq ?? 0) + 1;
    const id = `W${state.workerSeq}`;
    const dir = path.join(layout.workers, id);
    fs.mkdirSync(dir, { recursive: true });
    const briefPath = path.join(dir, "brief.md");
    const resultPath = path.join(dir, "result.json");
    const logPath = path.join(dir, "log.txt");
    fs.writeFileSync(briefPath, `${brief.trimEnd()}\n\n${renderTemplate("worker-contract", { ZONE: zone, WORKER_ID: id })}`, "utf8");
    const { pid } = spawnDetachedCodex({ args: buildWorkerArgs({ zone, effort, outFile: resultPath, model }), stdinFile: briefPath, logFile: logPath, cwd: zone });
    const now = Date.now();
    const worker = {
      id, zone, pid, effort, model, status: "running",
      startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + deadlineMs).toISOString(),
      briefPath, resultPath, logPath, usageBooked: false
    };
    state.workers.push(worker);
    saveState(project, state);
    return { worker: workerView(worker), activeWorkers: active.length + 1 };
  });
}

async function status({ project, positionals }) {
  return withLock(project, async () => {
    const state = loadState(project);
    if (refreshWorkers(state)) saveState(project, state);
    const workers = positionals[1] ? [findWorker(state, positionals[1])] : state.workers ?? [];
    return { workers: workers.map(workerView), active: activeZones(state).length };
  });
}

async function wait({ project, positionals, options }) {
  const id = requireId(positionals, "wait");
  const pollMs = Math.max(500, Number(options["poll-sec"] ?? 5) * 1000);
  const started = Date.now();
  let limit = options["timeout-min"] !== undefined ? started + minutes(options["timeout-min"]) : null;
  for (;;) {
    const view = await withLock(project, async () => {
      const state = loadState(project);
      const worker = findWorker(state, id);
      if (refreshWorkers(state)) saveState(project, state);
      return workerView(worker);
    });
    if (TERMINAL_STATUSES.has(view.status)) return { worker: view, waitedMs: Date.now() - started };
    limit ??= Date.parse(view.deadlineAt) + 60 * 1000; // the refresh marks a timeout at the deadline
    if (Date.now() > limit) return { worker: view, waitedMs: Date.now() - started, timedOutWaiting: true };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function cancel({ project, positionals }) {
  const id = requireId(positionals, "cancel");
  return withLock(project, async () => {
    const state = loadState(project);
    const worker = findWorker(state, id);
    cancelWorker(state, worker);
    saveState(project, state);
    return { worker: workerView(worker) };
  });
}

export async function runWorker(context) {
  const sub = context.positionals[0];
  if (!SUBCOMMANDS.includes(sub)) throw new TandemError("bad_subcommand", `worker needs one of: ${SUBCOMMANDS.join(", ")}.`, "Example: worker start --zone <abs> --brief-file <abs>");
  return { start, status, wait, cancel }[sub](context);
}
```

- [ ] **Step 7: Befehl registrieren** (`scripts/tandem.mjs`)

Import `import { runWorker } from "./commands/worker.mjs";` und in `COMMANDS`: `worker: runWorker,`.

- [ ] **Step 8: Test laufen lassen, Erfolg prüfen**

Run: `node --test tests/worker.test.mjs`
Expected: `# pass 5`, `# fail 0` (der Timeout-Fall dauert ~5 s).

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/state.mjs scripts/lib/workers.mjs references/templates/worker-contract.md scripts/commands/worker.mjs scripts/tandem.mjs tests/worker.test.mjs
git commit -m "feat(runner): sandboxed detached workers with zones, deadlines and structured results

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Lanes (`lane`) und Sparring-Kontakt

**Files:**
- Create: `references/templates/lane.md`
- Create: `scripts/commands/lane.mjs`
- Modify: `scripts/commands/contact.mjs` (`KINDS.sparring`)
- Modify: `scripts/tandem.mjs` (`lane` registrieren)
- Test: `tests/lane.test.mjs`, `tests/contact.test.mjs`

**Interfaces:**
- Produces: `LANE_KINDS` (`gegenposition`, `premortem`, `alternative`), `buildLaneArgs({ threadId, effort, outFile })`; `lane --kind <k> --prompt-file <abs> [--effort medium] [--deadline-min 8] [--min-remaining] [--force]` → `{ contactId, kind: "lane", laneKind, answer, replyPath, durationMs, attempts, rateLimits }`. Eine Lane ist ein ephemerer Fork des Tandem-Threads; ein Schema-Retry forkt erneut (Note + voller Prompt). Lanes zählen als Kontakt (`kind: "lane"`).
- `contact --kind sparring` → Schema `sparring`, Effort medium, Deadline 8; Rückgabe wie bei anderen Kontakten (`verdict` enthält das Sparring-Objekt).

- [ ] **Step 1: Lane-Vorlage anlegen** (`references/templates/lane.md`)

```markdown
# Tandem-Lane {{CONTACT_ID}} ({{KIND}})

Dies ist ein Seitenzweig des Tandem-Threads: du kennst Projekt und Verlauf, aber diese Antwort fließt nicht in den Hauptthread zurück. Claude verdichtet sie selbst.

{{INSTRUCTION}}

## Thema
{{BODY}}

## Antwortformat
Antworte ausschließlich als JSON nach dem Schema sparring, ohne Text davor oder danach: `position` (deine Kernaussage), `reasons` (max. 8), `checked` (was du tatsächlich gelesen hast), `risks` (max. 8), `recommendation` (ein konkreter nächster Schritt).
```

- [ ] **Step 2: Failing Tests schreiben**

`tests/lane.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeProject, readLog, runTandem, startProject, writeFile } from "./helpers.mjs";

function prepared(name) {
  const dir = makeProject(name);
  const logFile = path.join(dir, "fake.log");
  startProject(dir, { FAKE_THREAD_ID: "thread-main" });
  const prompt = writeFile(dir, "topic.md", "Sollen wir den Lock auf fd-Basis lassen oder auf eine SQLite-Datei umstellen?");
  return { dir, logFile, prompt };
}

test("lane forks the thread ephemerally with the sparring schema and books a contact", () => {
  const { dir, logFile, prompt } = prepared("lane");
  const { json } = runTandem(["lane", "--kind", "premortem", "--prompt-file", prompt], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.equal(json.kind, "lane");
  assert.equal(json.laneKind, "premortem");
  assert.equal(json.contactId, "C1");
  assert.equal(json.answer.position, "fake position");
  const call = readLog(logFile).find((c) => c.argv[0] === "exec");
  assert.deepEqual(call.argv.slice(0, 4), ["exec", "fork", "thread-main", "--ephemeral"]);
  assert.ok(call.argv.includes("sandbox_mode=read-only"));
  assert.ok(call.argv.includes("--output-schema"));
  assert.ok(call.stdin.includes("Tandem-Lane C1 (premortem)"));
  assert.ok(call.stdin.includes("Premortem"));
  assert.ok(call.stdin.includes("SQLite"));
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8"));
  assert.equal(state.contacts, 1);
  assert.equal(state.lastContact.kind, "lane");
  assert.equal(state.usage.byKind.lane.runs, 1);
});

test("unknown lane kind is rejected; an invalid answer is retried once by forking again", () => {
  const { dir, logFile, prompt } = prepared("lane-retry");
  assert.equal(runTandem(["lane", "--kind", "gossip", "--prompt-file", prompt], { cwd: dir }).json.error, "bad_kind");
  const { json } = runTandem(["lane", "--kind", "gegenposition", "--prompt-file", prompt], { cwd: dir, env: { FAKE_CODEX_LOG: logFile, FAKE_SPARRING_EMPTY: "1" } });
  assert.equal(json.error, "invalid_output");
  const forks = readLog(logFile).filter((c) => c.argv[1] === "fork");
  assert.equal(forks.length, 2);
  assert.ok(forks[1].stdin.includes("nicht schema-konform"));
  assert.ok(forks[1].stdin.includes("Gegenposition"));
  assert.equal(readLog(logFile).filter((c) => c.argv[0] === "app-server").length, 2);
});
```

`tests/contact.test.mjs`, ans Ende:
```js
test("sparring contact uses the sparring schema with medium effort", () => {
  const { dir, prompt, logFile } = prepared("sparring");
  const { json } = runTandem(["contact", "--kind", "sparring", "--prompt-file", prompt], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.equal(json.verdict.position, "fake position");
  assert.equal(json.verdict.recommendation, "do it");
  const call = readLog(logFile).find((c) => c.argv[1] === "resume");
  assert.ok(call.argv.includes("model_reasoning_effort=medium"));
  assert.ok(call.argv.some((a) => a.endsWith("sparring.schema.json")));
  assert.ok(call.stdin.includes("Tandem-Kontakt C1 (sparring)"));
});
```
Und im bestehenden Test „resume contact starts a new session…" die letzte Zeile (`sparring … bad_kind`) **entfernen**, da `sparring` jetzt gültig ist.

- [ ] **Step 3: Tests laufen lassen, Fehlschlag prüfen**

Run: `node --test tests/lane.test.mjs tests/contact.test.mjs`
Expected: FAIL (`unknown_command` für lane, `bad_kind` für sparring).

- [ ] **Step 4: lane.mjs implementieren**

```js
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
```

- [ ] **Step 5: Sparring-Kontakt freischalten** (`scripts/commands/contact.mjs`)

In `KINDS` ergänzen:
```js
  sparring: { schema: "sparring", effort: "medium", deadline: 8 }
```
und im `bad_kind`-Hinweis den Zusatz „(sparring folgt in Plan B)" entfernen.

- [ ] **Step 6: Befehl registrieren** (`scripts/tandem.mjs`)

Import `import { runLane } from "./commands/lane.mjs";` und in `COMMANDS`: `lane: runLane,`.

- [ ] **Step 7: Tests laufen lassen, Erfolg prüfen**

Run: `node --test tests/lane.test.mjs tests/contact.test.mjs`
Expected: `# pass 11`, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add references/templates/lane.md scripts/commands/lane.mjs scripts/commands/contact.mjs scripts/tandem.mjs tests/lane.test.mjs tests/contact.test.mjs
git commit -m "feat(runner): fork lanes and sparring contacts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `status` kennt Worker, `stop` bricht Worker ab

**Files:**
- Modify: `scripts/commands/status.mjs`
- Modify: `scripts/commands/control.mjs`
- Test: `tests/status.test.mjs`

**Interfaces:**
- `status` läuft unter Lock, ruft `refreshWorkers` und speichert bei Änderung; `workers` sind `workerView`s; `human` zeigt aktive Worker mit Zone.
- `stop` bricht alle nicht-terminalen Worker ab (`cancelWorker`) und meldet `cancelledWorkers`.

- [ ] **Step 1: Failing Test ergänzen** (`tests/status.test.mjs`, ans Ende)

```js
test("status refreshes workers and stop cancels the active ones", () => {
  const dir = makeProject("status-workers");
  startProject(dir);
  const zone = path.join(dir, "zone");
  fs.mkdirSync(zone);
  const brief = writeFile(dir, "brief.md", ["## Ziel", "x", "## Nicht-Ziele", "y", "## Erlaubte Dateien", "-", "## Akzeptanztests", "-", "## Stop-Bedingungen", "-"].join("\n"));
  const started = runTandem(["worker", "start", "--zone", zone, "--brief-file", brief, "--deadline-min", "5"], { cwd: dir, env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  const status = runTandem(["status", "--human"], { cwd: dir });
  assert.equal(status.json.workers.length, 1);
  assert.equal(status.json.workers[0].status, "running");
  assert.equal(status.json.workers[0].usageBooked, undefined);
  assert.match(status.json.human, /Worker aktiv: 1/);
  const stopped = runTandem(["stop"], { cwd: dir });
  assert.equal(stopped.json.cancelledWorkers, 1);
  assert.equal(runTandem(["status"], { cwd: dir }).json.workers[0].status, "cancelled");
});
```
Imports oben ergänzen: `import fs from "node:fs"; import path from "node:path";` und `writeFile` aus den Helfern.

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `node --test tests/status.test.mjs`
Expected: FAIL (`cancelledWorkers` undefined bzw. Status bleibt running).

- [ ] **Step 3: status.mjs anpassen**

Imports ergänzen: `import { loadState, saveState, withLock } from "../lib/state.mjs";` (statt nur loadState) und `import { activeZones, refreshWorkers, workerView } from "../lib/workers.mjs";`.

`renderHuman`: letzte Zeile ersetzen durch
```js
    `Worker aktiv: ${summary.activeWorkers}${summary.activeWorkers ? ` (${summary.workers.filter((w) => !w.finishedAt).map((w) => `${w.id} ${w.zone}`).join(", ")})` : ""} · Codex ${summary.codexVersion ?? "?"}`
```

`runStatus`:
```js
export async function runStatus({ project, options }) {
  return withLock(project, async () => {
    const state = loadState(project);
    if (refreshWorkers(state)) saveState(project, state);
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
```

- [ ] **Step 4: control.mjs anpassen**

Import `import { TERMINAL_STATUSES, cancelWorker } from "../lib/workers.mjs";` und den `stop`-Zweig ersetzen:
```js
    } else if (command === "stop") {
      state.paused = true;
      state.stopped = true;
      cancelledWorkers = (state.workers ?? []).filter((worker) => !TERMINAL_STATUSES.has(worker.status) && cancelWorker(state, worker)).length;
```
Vor dem `if (command === "mode")` die Variable `let cancelledWorkers = 0;` anlegen und im Rückgabeobjekt `cancelledWorkers` ergänzen.

- [ ] **Step 5: Test laufen lassen, Erfolg prüfen**

Run: `node --test tests/status.test.mjs`
Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/commands/status.mjs scripts/commands/control.mjs tests/status.test.mjs
git commit -m "feat(runner): status refreshes workers, stop cancels them

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Doku, Spec, Smoke, Abnahme

**Files:**
- Modify: `SKILL.md` (Abschnitte Sparring, Lanes, Arbeitsteilung; Beschreibung im Frontmatter)
- Modify: `references/contracts.md` (Sparring, Lane, Worker-Handover)
- Modify: `README.md` (Feature-Tabelle, Befehlstabelle, Roadmap, Test-Zahl)
- Modify: `docs/2026-09-06-tandem-design.md` (Entscheidungs-Log: Plan B)
- Create: `tests/smoke-workers.mjs` (Opt-in gegen echtes Codex)

- [ ] **Step 1: SKILL.md ergänzen** — nach dem Abschnitt „Abschluss: zwei Urteile" einfügen:

```markdown
---

## Sparring (`/tandem frag <text>`) und Lanes (`/tandem lane <art> <thema>`)

- **Sparring:** freie Frage an den Thread (Idee, Architektur, Bug-Hypothese). Prompt-Datei mit Frage + Kontext, dann `contact --kind sparring --prompt-file <abs>` (Effort medium). Antwort: `position`, `reasons`, `checked`, `risks`, `recommendation`. Erkenntnis in einem Satz ins Ledger („Entscheidungen" oder „Stand").
- **Lanes:** `lane --kind gegenposition|premortem|alternative --prompt-file <abs>`. Ein ephemerer Fork des Threads: kennt alles, seine Antwort landet nicht im Hauptthread. Nur das Destillat ins Ledger; beim nächsten regulären Kontakt in zwei Sätzen erwähnen, was die Lane ergab. Gegenposition vor großen Entscheidungen, Premortem vor riskanten Umsetzungen, Alternative wenn ein Weg alternativlos wirkt.

---

## Arbeitsteilung (`/tandem worker <zone> <auftrag>`)

Codex erledigt eine abgegrenzte Teilaufgabe **mit Schreibrecht**, parallel und im Hintergrund, in einer **Zone** (Ordner), die die Sandbox erzwingt.

1. **Zone wählen:** ein Unterordner des Projekts, der nur Dateien des Auftrags enthält. Nie das Projekt-Root, nie `.tandem/`, nie Ordner mit `node_modules`, `dist`, `build`, `.next`, `target`, `.git`, keine Junctions, nicht unter `%TEMP%`, keine Überlappung mit einer aktiven Zone. Höchstens **zwei** Worker gleichzeitig.
2. **Handover-Brief** schreiben (absoluter Pfad, Vorlage `references/templates/worker-brief.md`), Pflicht-Überschriften: `## Ziel`, `## Nicht-Ziele`, `## Erlaubte Dateien`, `## Akzeptanztests`, `## Stop-Bedingungen`; dazu `## Auftragstyp` (Kategorie + ein Satz, warum der Auftrag zu Codex passt), `## Schnittstellen`, `## Löschrechte`, Baseline und ein Ledger-Auszug (Entscheidungen, Konventionen). Der Runner hängt den Worker-Vertrag an.
3. `worker start --zone <abs> --brief-file <abs>` (Effort medium, `high` bei Security/Migration; Deadline 20 min; optional `--model <name>`, wenn der Nutzer für mechanische Aufträge ein schnelleres Codex-Modell wünscht). Ledger-Zeile unter „Zonen und Worker".

**Zuteilung nach Stärken** (wer macht was):

| An Codex als Worker | Bei Claude |
|---|---|
| Tests und Fixtures für vorhandenen Code; Parser, Validator, Konverter gegen eine Spezifikation; Modul-Portierung nach Vorlage; Migrationen mit klarer Zielstruktur; Repo-Recherche mit Bericht; Referenz-Doku aus Code; Audit einer Zone | UI/UX, Texte für den Nutzer, visuelle Prüfung im Browser; Architektur- und Scope-Entscheidungen; Änderungen quer über viele Ordner; Integration der Worker-Ergebnisse; Ledger und Entscheidungen; Sicherheitskritisches mit Nutzer-Stopp |
| Kriterium: Ziel lässt sich in Akzeptanztests fassen, die in der Zone laufen, und braucht keinen Kontext außerhalb von Brief + Repo | Kriterium: braucht Nutzerkontakt, Geschmack, Gesamtkontext oder Schreibrecht außerhalb einer Zone |

Bewährte Muster: Claude baut Skelett und Schnittstellen, Codex füllt Zonen mit Implementierung und Tests; Codex schreibt zuerst die Tests einer Zone, Claude implementiert; Codex auditiert eine Zone, während Claude woanders weiterbaut. Passt ein Auftrag in keine Codex-Kategorie, macht Claude ihn selbst.
4. **Während der Worker läuft, die Zone nicht anfassen.** Weiterarbeiten außerhalb; Checkpoints laufen normal.
5. `worker wait <id>` (im Hintergrund per Bash `run_in_background`) oder `worker status`. Ergebnis `DONE|PARTIAL|BLOCKED` mit `touchedFiles`, `tests`, `remaining`, `blockers`.
6. **Echten Diff prüfen** (Git: `git status`/`git diff -- <zone>`; ohne Git: Dateiliste), Tests selbst ausführen, integrieren, dann ein Begleiter-Checkpoint zur Integration. `timeout`, `orphaned`, `failed`, `invalid_output`: Log unter `.tandem/workers/<id>/log.txt` lesen, Zone prüfen, Auftrag ggf. enger fassen und neu starten. `worker cancel <id>` bricht ab; `stop` bricht alle ab.
```

Im Frontmatter `description` den Satz „Sparring, Arbeitsteilung, Design-Galerie und Board folgen in Plan B–D." ersetzen durch „Sparring, Lanes und Arbeitsteilung (Plan B) sind enthalten; Design-Galerie und Board folgen in Plan C–D."

- [ ] **Step 1b: Brief-Vorlage für Claude anlegen** (`references/templates/worker-brief.md`; Claude kopiert und füllt sie, der Runner liest sie nicht)

```markdown
# Worker-Auftrag {{WORKER_ID}}: {{TITEL}}

## Auftragstyp
<Tests | Parser/Validator | Portierung | Migration | Recherche | Referenz-Doku | Audit> — warum Codex: <ein Satz>

## Baseline
<git HEAD oder Datum>

## Ziel
<was am Ende in der Zone existiert, in Prüfsätzen>

## Nicht-Ziele
<was ausdrücklich nicht angefasst wird>

## Erlaubte Dateien
- <Pfade relativ zur Zone>

## Schnittstellen
<Funktionen/Formate, die Claudes Teil erwartet, mit Signaturen>

## Akzeptanztests
- <Befehl> → erwartetes Ergebnis

## Löschrechte
<keine | nur diese Dateien>

## Stop-Bedingungen
<wann BLOCKED statt raten>

## Kontext aus dem Ledger
<Entscheidungen und Konventionen, die für den Auftrag zählen>
```

- [ ] **Step 2: contracts.md ergänzen** (vor „Antwort-Regeln für Codex")

```markdown
## Sparring (`templates/contact.md` mit Schema sparring)
Freie Frage mit Kontext im Body. Antwort nach `schemas/sparring.schema.json`: `position`, `reasons` (≤ 8), `checked`, `risks` (≤ 8), `recommendation`; `position` und `recommendation` dürfen nicht leer sein.

## Lane (`templates/lane.md`)
Ephemerer Fork des Threads mit einer von drei Anweisungen (Gegenposition, Premortem, Alternative) und Claudes Thema. Antwort nach `sparring`-Schema. Ein Schema-Retry forkt erneut mit Hinweis.

## Worker-Handover (Brief von Claude + `templates/worker-contract.md`)
Claude liefert Ziel, Nicht-Ziele, erlaubte Dateien, Schnittstellen, Akzeptanztests, Löschrechte, Stop-Bedingungen, Baseline und Ledger-Auszug. Der Runner hängt den Vertrag an (nur Zone, kein Commit, keine Caches, BLOCKED statt raten). Rückgabe nach `schemas/worker-result.schema.json`: `status DONE|PARTIAL|BLOCKED`, `touchedFiles`, `tests[{cmd,exitCode}]`, `remaining`, `blockers[{text,evidence}]`, `notes`; DONE nur ohne Restarbeit und Blocker.
```

- [ ] **Step 3: README anpassen**

Feature-Tabelle, nach „Two final verdicts" einfügen:
```markdown
| **Sparring and lanes** | Free-form questions on the persistent thread, plus ephemeral forks of it (counter-position, premortem, alternative) whose answers never pollute the main thread. |
| **Work split** | Codex workers implement bounded tasks with write access, detached and in parallel (max. two), confined by the OS sandbox to a zone folder the runner validates (no shared caches, no reparse points, never under TEMP). Structured `DONE / PARTIAL / BLOCKED` results with tests and touched files. Tasks are allocated by strength: Codex gets test-writing, parsers and converters against a spec, ports, migrations, repo research and audits; Claude keeps UI, cross-cutting changes, architecture, integration and everything that needs the user. Optional `--model` per worker. |
```
Befehlstabelle ergänzen:
```markdown
| `contact --kind sparring --prompt-file <abs>` | Free-form question with the sparring schema (position, reasons, risks, recommendation). |
| `lane --kind gegenposition\|premortem\|alternative --prompt-file <abs>` | Ephemeral fork of the thread; one schema retry by forking again. |
| `worker start --zone <abs> --brief-file <abs> [--effort] [--deadline-min 20]` | Validates the zone and the brief, appends the worker contract, starts Codex detached with `workspace-write` confined to the zone. |
| `worker status [id]`, `worker wait <id> [--poll-sec 5]`, `worker cancel <id>` | Lifecycle: results are parsed and validated, deadlines kill the process tree, usage is booked from the log. |
```
Im Absatz „Planned next" die Worte „**sparring with fork lanes**, **work split** with sandbox-enforced write zones for Codex workers, " entfernen. Test-Zahl in „Project layout" und „Development" auf die finale Zahl setzen (nach Task 6 Step 6).

- [ ] **Step 4: Spec-Entscheidungs-Log ergänzen** (Abschnitt 14, ans Ende)

```markdown
**Abnahme Plan B (Datum eintragen)**
- Worker (Zonen per Sandbox, detached, Deadlines, strukturierte Rückgabe), Sparring-Kontakte, Fork-Lanes; `status` und `stop` kennen Worker.
- Verifiziert gegen echtes Codex: `codex exec fork --ephemeral` mit Schema (Lane) und ein Worker in einer Zone (Smoke `tests/smoke-workers.mjs`).
```

- [ ] **Step 5: Smoke-Skript anlegen** (`tests/smoke-workers.mjs`, Opt-in, kostet Tokens)

```js
#!/usr/bin/env node
// Lane + worker against the REAL codex CLI (low effort). Usage: node tests/smoke-workers.mjs <absolute project outside TEMP>
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
fs.mkdirSync(path.join(project, "zone"), { recursive: true });
fs.writeFileSync(path.join(project, "index.js"), "export function add(a, b) { return a + b; }\n", "utf8");

function run(args) {
  const env = { ...process.env };
  delete env.TANDEM_CODEX_BIN;
  const result = spawnSync(process.execPath, [runner, ...args], { cwd: project, encoding: "utf8", env });
  const line = (result.stdout || "").trim().split(/\r?\n/).pop() ?? "";
  console.log(args.slice(0, 2).join(" "), "→", line.slice(0, 500));
  try {
    return JSON.parse(line);
  } catch {
    console.error(result.stderr);
    process.exit(1);
  }
}

if (!fs.existsSync(path.join(project, ".tandem", "state.json"))) {
  const summary = path.join(project, "summary.md");
  fs.writeFileSync(summary, "Wegwerf-Projekt für den tandem-Smoke-Test (Plan B): index.js mit add(a, b), Ordner zone/ für einen Worker.", "utf8");
  run(["start", "--summary-file", summary, "--effort", "low"]);
}
const topic = path.join(project, "topic.md");
fs.writeFileSync(topic, "Sollte add(a, b) Typen prüfen oder JavaScript-Koerzion zulassen? Kontext: winzige Bibliothek ohne Nutzer.", "utf8");
run(["lane", "--kind", "premortem", "--prompt-file", topic, "--effort", "low"]);
const brief = path.join(project, "brief.md");
fs.writeFileSync(brief, ["## Ziel", "Lege in der Zone eine Datei hello.txt mit dem Inhalt hello an.", "## Nicht-Ziele", "Keine anderen Dateien.", "## Erlaubte Dateien", "- hello.txt", "## Schnittstellen", "keine", "## Akzeptanztests", "- hello.txt existiert und enthält hello", "## Löschrechte", "keine", "## Stop-Bedingungen", "Bei Unklarheit BLOCKED."].join("\n"), "utf8");
const started = run(["worker", "start", "--zone", path.join(project, "zone"), "--brief-file", brief, "--effort", "low", "--deadline-min", "5"]);
if (!started.ok) process.exit(1);
const waited = run(["worker", "wait", started.worker.id, "--poll-sec", "3"]);
console.log("hello.txt:", fs.existsSync(path.join(project, "zone", "hello.txt")) ? fs.readFileSync(path.join(project, "zone", "hello.txt"), "utf8").trim() : "(missing)");
console.log("outside leak:", fs.existsSync(path.join(project, "hello.txt")) ? "YES (bad)" : "none");
process.exit(waited.ok && waited.worker.status === "done" ? 0 : 1);
```

- [ ] **Step 6: Gesamte Suite, Zahl eintragen, Commit**

Run: `npm test` → Expected `# fail 0`; die Test-Zahl in README (zwei Stellen) eintragen.

```bash
git add SKILL.md references/contracts.md references/templates/worker-brief.md README.md docs/2026-09-06-tandem-design.md tests/smoke-workers.mjs
git commit -m "docs(skill): sparring, lanes and work split with strength-based allocation; smoke script for workers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Abnahme von Plan B

1. `npm test` grün.
2. Smoke gegen echtes Codex auf Zuruf: `node tests/smoke-workers.mjs C:\Users\david\tandem-smoke` (low effort), danach Ordner löschen. Prüft `codex exec fork --ephemeral` mit Schema (Spec 12.2) und einen echten Worker in einer Zone (kein Leak außerhalb).
3. Abschluss nach Spec 4.5 mit tandem selbst: `review --base main` auf dem Branch und `contact --kind final` auf dem Dauer-Thread des Skill-Repos; echte Befunde fixen, bis das Schlussurteil OK ist.
4. Merge nach `main`, Push nach GitHub, Spec-Datum in „Abnahme Plan B" eintragen.
