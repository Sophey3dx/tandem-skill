# Tandem — Design (2026-09-06)

**Tandem** ist ein Claude-Code-Skill, mit dem Claude (Fable/Opus) und **Codex** (OpenAI CLI) über ein
ganzes Projekt hinweg dauerhaft kooperieren. Der Unterschied zu [`duofold`](../../duofold/SKILL.md):
kein Einzel-Briefing pro Frage, sondern **ein Codex-Thread pro Projekt mit Gedächtnis**, feste
**Kontaktpunkte** nach Protokoll, ein **Plan-Konsens mit Automode**, **Sparring** mit Gedächtnis,
**Arbeitsteilung** mit Schreibrecht für Codex in abgesicherten Zonen und eine **Design-Galerie**, in der
beide je eine UI-Variante bauen und der Nutzer sie nebeneinander im Browser vergleicht.

Status: Design freigegeben (Sophey, 2026-09-06), Codex-Review per Duofold eingearbeitet.
Nächster Schritt: Implementierungsplan (`superpowers:writing-plans`).

---

## 1. Ziel und Nicht-Ziele

**Ziel**
- Ständiger Austausch mit Codex während eines Projekts, ohne jedes Mal einen vollständigen Brief zu schreiben.
- Codex kennt Projekt, Entscheidungen und frühere Einwände (Thread-Gedächtnis), Claude schickt nur noch Deltas.
- Pläne werden im Konsens verabschiedet und bei Zustimmung **automatisch** umgesetzt.
- Codex kann eigene Teilaufgaben parallel erledigen, ohne Claudes Arbeitsbaum zu gefährden.
- Bei UI-Arbeit liefern beide je eine Design-Variante; der Nutzer vergleicht sie im Browser und wählt.
- Token-sparend: Codex-Reasoning bleibt im Codex-Prozess, Claude liest nur gecappte, schema-konforme Antworten.

**Nicht-Ziele (v1)**
- Keine Hooks (kein Stop-Gate, kein Edit-Hook). Kontakte löst ausschließlich Claude nach Protokoll aus.
- Kein eigener App-Server-Client, kein MCP-Server (abgekündigt).
- Keine Änderung an `superpowers`, `duofold`, `trifold` oder dem OpenAI-Codex-Plugin.
- Kein Live-Steering oder Unterbrechen laufender Codex-Turns.

---

## 2. Verifizierte Grundlagen (Windows 11, Codex CLI 0.153.2, 2026-09-06)

| # | Befund | Konsequenz |
|---|--------|------------|
| 1 | `codex mcp-server` läuft, meldet aber „deprecated and will be removed". `codex-reply` aus einem neuen Prozess: „Session not found". | MCP als Kanal verworfen. |
| 2 | `codex exec resume <threadId> -` setzt einen Thread prozessübergreifend fort und erinnert sich (Codewort-Test). | Kanal A: CLI-Thread-Resume. |
| 3 | `codex exec --json` liefert als erstes Event `{"type":"thread.started","thread_id":"…"}`. | Thread-ID-Erfassung beim Start. |
| 4 | `codex exec resume` akzeptiert `-c sandbox_mode=read-only` und `-c model_reasoning_effort=…`; hat **kein** `-C`/`-s`. | Sandbox/Effort per `-c`, cwd bleibt am Thread. |
| 5 | `--output-schema` beim Resume funktioniert; Schema muss **strict** sein (alle Properties in `required`, optionale Felder als `["string","null"]`). | JSON-Verdicts statt Erste-Zeile-Konvention. |
| 6 | `codex exec review` hat `--uncommitted`/`--base`/`--commit`, `--output-schema`, `--json`, `-o`, `--skip-git-repo-check`. | Frischer Diff-Review als zweites Abschlussurteil. |
| 7 | `codex exec fork <id>` existiert (mit `--ephemeral`, `--output-schema`, `-o`), ohne `-C`/`-s`. | Lanes im Sparring; **nicht** für Worker. |
| 8 | Windows-Sandbox (`[windows] sandbox = "unelevated"`, restricted token): `-s workspace-write -C <zone>` schreibt in der Zone; Eltern-, Nachbar-Ordner und Desktop: „Access to the path … is denied". | Zonen sind technisch erzwungen. |
| 9 | Liegt das Projekt unter `%TEMP%`, ist alles beschreibbar (workspace-write erlaubt cwd + /tmp + $TMPDIR). | Runner lehnt Zonen in TEMP/TMP ab. |
| 10 | Großer Prompt als Positional-Argument blockiert unter PowerShell (bekannter Duofold-Kniff). | Prompts **immer** per stdin bzw. Datei. |
| 11 | Nutzer-Config: `model = gpt-5.6-sol`, `model_reasoning_effort = high`, `personality = pragmatic`. | Modell nicht überschreiben, Effort je Kontakt-Typ. |
| 12 | `codex app-server` (stdio, JSON-RPC) beantwortet nach `initialize` die Anfrage `account/rateLimits/read` **ohne Modellaufruf** mit `primary` (5-h-Fenster) und `secondary` (Wochenfenster), je `usedPercent`, `windowDurationMins`, `resetsAt` (Unix-Sekunden), dazu `planType` und `rateLimitReachedType`. | Nutzungs-Wächter: Restnutzung vor jedem Aufruf prüfen. |
| 13 | `codex login status` gibt bei Login Exit 0 („Logged in using ChatGPT"). npm-Shim `codex.cmd` startet `node <npm>\node_modules\@openai\codex\bin\codex.js`; JSONL-Events: `thread.started{thread_id}`, `turn.started`, `item.completed{item.type=agent_message,text}`, `turn.completed{usage{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens}}`. | `doctor`, Binary-Auflösung ohne cmd.exe-Quoting, Usage aus Events. |

---

## 3. Architektur

### 3.1 Kanal A: CLI-Thread-Resume
- **Ein Thread pro Projekt.** Start: `codex exec --json -C <projekt> -s read-only --skip-git-repo-check -c model_reasoning_effort=medium -o <abs> -` mit Onboarding-Prompt per stdin. Thread-ID aus dem `thread.started`-Event.
- **Jeder Kontakt:** `codex exec resume <threadId> --skip-git-repo-check -c sandbox_mode=read-only -c model_reasoning_effort=<e> --output-schema <abs schema> -o <abs reply> -`, Prompt per stdin.
- **Der Tandem-Thread ist immer read-only.** Schreibrecht haben nur Worker (eigene Prozesse, eigene Threads, cwd = Zone).
- **Claude liest nur die `-o`-Datei** (JSON), nie Roh-Reasoning oder JSONL-Events. Das ist die Token-Sparmechanik.
- **Alle Pfade absolut** (Schema, Ausgabe, Zonen, Prompt-Dateien). Relative Pfade in Kombination mit `-C` gelten als Fehlerquelle.

Verworfen: (B) Plugin-Runtime des OpenAI-Codex-Plugins (Kopplung an Interna, geteilter Thread-Namensraum mit `/codex:rescue`, Session-Filter), (C) eigener App-Server-Client (mächtig, aber eigener Node-Client zu pflegen; Option für v2, wenn Turn-Unterbrechung oder Live-Steering gebraucht wird).

### 3.2 Runner (`scripts/tandem.mjs`)
Ein Node-Skript **ohne Abhängigkeiten** (Node ≥ 18, wie das OpenAI-Plugin). Claude ruft **nur den Runner**, nie handgebaute `codex`-Befehle. Der Runner kapselt:
- stdin-Übergabe der Prompts aus Dateien (Windows-Kniff),
- JSONL-Parsing (Thread-ID), Schema-Übergabe, Parsen und Validieren der Antwort-JSON,
- atomaren Zustand (`state.json` via Temp-Datei + Rename), Lock-Datei mit PID und Zeitstempel, Erkennung veralteter Locks,
- Deadlines je Kontakt-Typ, Abbruch des **Prozessbaums** (Windows: `taskkill /PID <pid> /T /F`),
- Zonen-Prüfungen und Worker-Verwaltung (detached, PID, Deadline, Ergebnisdatei),
- Fehlererkennung (nicht resumierbar, Limit, ungültige Antwort) mit definiertem Fallback,
- Design-Runden (Ordner, Vite-Einstieg, Entscheidung, Cleanup) und den Tandem-Server mit Galerie und Board (4.6, 4.7),
- **Kosten-Zähler:** Token-Verbrauch je Codex-Lauf aus dem JSONL-Event `turn.completed` (Feld `usage`; Fallback: die `tokens used`-Zeile auf stderr, locale-bewusst geparst, z. B. `57.717` unter de-DE) in `state.usage` summieren (gesamt, je Kontakt-Art, je Session) und in `status` ausgeben,
- **Nutzungs-Wächter:** vor **jedem** Codex-Lauf liest der Runner die Restnutzung über `codex app-server` (`account/rateLimits/read`, kein Modellaufruf, etwa eine Sekunde): 5-h-Fenster und Wochenfenster als Rest in Prozent plus Reset-Zeitpunkt. Liegt ein Fenster unter der Schwelle (Standard 10 %, dauerhaft per `config --min-remaining <n>`, je Aufruf per `--min-remaining <n>`, `0` erzwingt), bricht der Runner mit `quota_low` ab, ruft Codex nicht auf und nennt Fenster und Reset-Zeit. Schlägt die Abfrage fehl, läuft der Aufruf trotzdem und `status` zeigt „Restnutzung unbekannt". Werte werden in `state.rateLimits` gecacht und in `status`, `doctor` und Board angezeigt,
- Codex-Verfügbarkeit/-Version (`doctor`).

Ausgabe des Runners: immer **eine JSON-Zeile** auf stdout (`{ok, …}`), Fehler mit `ok:false, error, hint`. Exitcode 0 bei ok, 1 sonst. Menschlich lesbare Zusammenfassung optional mit `--human`.

Aufruf: `node "%USERPROFILE%\.claude\skills\tandem\scripts\tandem.mjs" <cmd> [optionen]` aus dem Projekt-Root (oder mit `--project <abs>`).

### 3.3 Ledger `.tandem/` im Projekt
```
.tandem/
  state.json          Runner-Zustand (Thread, Modus, Zähler, Worker, Plan-Runde, Codex-Version, History, Token-Verbrauch `usage`, Server-PID)
  lock                PID + Zeitstempel, nur während ein Runner-Befehl läuft
  ledger.md           Claudes Gedächtnis: Entscheidungen, offene/abgelehnte/zurückgestellte Einwände, Checkpoint-Log, Zonen-Vergaben
  prompts/            von Claude geschriebene Prompt-Dateien je Kontakt (NNNN-<kind>.md)
  replies/            Codex-Antworten (NNNN-<kind>.json)
  plans/              Plan-Dokumente je Runde (plan-r1.md, plan-r2.md, …) + Matrix-Dateien
  workers/<id>/       brief.md, result.json, log.txt
  design/<N>/         Standalone-Galerie: brief.md, claude/index.html, codex/index.html, je notes.md, decision.json
```
- `.tandem/` ist **lokal** und gehört in die `.gitignore` (der Runner ergänzt den Eintrag bei `start`, wenn ein Git-Repo vorliegt und der Eintrag fehlt).
- **Ledger vs. Thread:** Der Thread ist Codex' Gedächtnis, `ledger.md` ist Claudes Gedächtnis über Kontext-Kompaktierung und Session-Neustarts hinweg. Dauerhafte Entscheidungen wandern zusätzlich in die normalen Projekt-Docs.
- **Einwände** (Objections) verwaltet Claude in `ledger.md` mit stabilen IDs (`C12-2` = Kontakt 12, Punkt 2). Der Runner speichert nur die Verdict-JSONs; die Matrix für Codex schreibt Claude in die Prompt-Datei.

### 3.4 Schemas (strict, `references/schemas/`)
- **verdict.schema.json** (Checkpoint, Resume, Abschluss): `verdict ∈ {OK, CONCERN, BLOCK}`, `checked: string[]`, `points: [{id, severity ∈ {BLOCKER, MAJOR, MINOR}, text, file: string|null, line: integer|null}]` (max. 5), `residualRisk: string`.
- **plan-verdict.schema.json**: `verdict ∈ {APPROVE, REVISE}`, `checked: string[]`, `criteria: {blockersOpen: integer, sourcesRead: boolean, testStrategyFeasible: boolean, residualRisk: string}`, `points: [{id, severity, category ∈ {correctness, security, scope, testability}, text, section: string|null, newEvidence: string|null}]` (max. 8).
- **worker-result.schema.json**: `status ∈ {DONE, PARTIAL, BLOCKED}`, `touchedFiles: string[]`, `tests: [{cmd, exitCode: integer}]`, `remaining: string[]`, `blockers: [{text, evidence}]`, `notes: string`.
- **sparring.schema.json** (Sparring, Lanes): `position: string`, `reasons: string[]`, `checked: string[]`, `risks: string[]`, `recommendation: string`.

Der Runner validiert Pflichtfelder und Enums selbst (kein externer Validator). Ungültige Antwort → ein Wiederholungsversuch mit Schema-Hinweis, sonst Kontakt „failed".

---

## 4. Modi und Protokolle

Gemeinsam für alle Modi: derselbe read-only Tandem-Thread, der Ledger, der Kontakt-Umschlag, JSON-Verdicts, Anti-Sycophancy-Regeln aus dem Onboarding.

### 4.1 Begleiter (Standard, sobald tandem aktiv und nicht pausiert)
**Checkpoints** (Claude löst aus): nach einem Plan oder einer Design-Entscheidung; nach jedem zusammenhängenden Edit-Block, sobald Tests gelaufen sind; vor jedem „fertig"; zusätzlich auf Zuruf (`/tandem check`).

**Kontakt-Umschlag** (Prompt-Datei, Vorlage in `references/contracts.md`):
1. Kontakt-ID und Modus
2. Baseline (Git-HEAD oder, ohne Git, Zeitstempel + Dateiliste)
3. geänderte Pfade
4. Delta in Worten (was, warum; ≤ 15 Zeilen)
5. Testbelege (Befehle + Exitcodes)
6. Matrix offener/abgelehnter/zurückgestellter Einwand-IDs mit Begründung
7. **genau eine** Prüffrage

Codex liest die Dateien selbst (read-only). Antwort nach `verdict.schema.json`.

**Claudes Reaktion** pro Punkt: **annehmen** (jetzt fixen), **begründet ablehnen** (Ledger), **zurückstellen** (Ledger, offene Liste). Abgelehnte und zurückgestellte Punkte gehen beim nächsten Kontakt als Matrix mit. Ein **BLOCK vor „fertig"** wird gefixt oder dem Nutzer vorgelegt, nie übergangen.

### 4.2 Plan-Konsens mit Automode
**Eigener Planungsfluss** (die Nutzer-Freigabe der `superpowers:brainstorming`-Skill wird im Plan-Modus durch den Konsens ersetzt; das ist die Automode-Entscheidung des Nutzers):
1. **Kontext:** Ziel, Nicht-Ziele, Constraints, Akzeptanztests, Alternativen, Rollback, Pfadliste. Rückfragen an den Nutzer sind hier erlaubt und erwünscht (eine Frage pro Nachricht, wie beim Brainstorming).
2. **Plan-Dokument** im `writing-plans`-Format nach `.tandem/plans/plan-r1.md`, mit Plan-Hash.
3. **Konsens-Loop**, max. 3 Runden:
   - Runde 1: voller Plan an Codex, Effort **high**, Schema `plan-verdict`.
   - Runden 2–3: überarbeiteter voller Plan + **Matrix** (`Einwand-ID → accepted | rejected | deferred + Begründung`), Effort **medium**. Codex liest jedes Mal den vollen Plan und nennt geprüfte Dateien/Abschnitte.
   - **APPROVE-Kriterien** (im Schema und im Vertrag): `blockersOpen = 0` und keine offenen MAJOR, `sourcesRead = true`, `testStrategyFeasible = true`, `residualRisk` benannt.
   - **REVISE** nur für Korrektheit, Sicherheit, Scope, Prüfbarkeit. Neue Blocker ab Runde 2 brauchen `newEvidence`. Stilwünsche sind nie blockierend.
4. **APPROVE → Automode:** Umsetzung startet sofort über `superpowers:executing-plans` bzw. `subagent-driven-development`, mit Begleiter-Checkpoint nach jeder Aufgabe, danach Abschluss (4.5).
5. **Kein Konsens nach Runde 3:** Stopp. Claude legt dem Nutzer beide Positionen plus eigene Empfehlung vor; der Nutzer entscheidet.

**Automode-Grenze:** Irreversible oder nach außen wirkende Schritte (Deploys, Löschen von Nutzerdaten, Zahlungen, Nachrichten nach außen, Änderungen an Produktionskonfiguration) bekommen **immer** einen Stopp beim Nutzer, auch bei Konsens. Der Plan markiert solche Schritte explizit.

### 4.3 Sparring
- Freie Fragen an den Thread (Ideen, Architektur, Bug-Hypothesen), Schema `sparring`, Effort medium. Codex antwortet kompakt mit Position, Gründen, Geprüftem, Risiken, Empfehlung.
- **Lanes** (`/tandem lane gegenposition|premortem|alternative <thema>`): `codex exec fork <threadId> --ephemeral` read-only, Effort medium, Schema `sparring`. Die Lane erbt das Thread-Gedächtnis, verschmutzt den Hauptthread aber nicht. Nur das Destillat landet im Ledger; beim nächsten regulären Kontakt erfährt der Hauptthread das Ergebnis in zwei Sätzen.

### 4.4 Arbeitsteilung (Split)
- **Auftrag** (`.tandem/workers/<id>/brief.md`, Vorlage in `contracts.md`), Pflichtfelder: kanonische Projekt- und Zonenpfade, Baseline, Ziel und Nicht-Ziele, erlaubte Dateien, Schnittstellen zu Claudes Teil, Akzeptanztests, Löschrechte, Stop-Bedingungen, Ledger-Auszug (Entscheidungen, Konventionen).
- **Worker** = frischer Prozess: `codex exec --json -C <zone> -s workspace-write --skip-git-repo-check -c model_reasoning_effort=<e> --output-schema worker-result -o <abs result.json> -` im Hintergrund (detached; stdin aus der Brief-Datei per Shell-Redirect, stdout/stderr in `log.txt`), Deadline default 20 min.
- **Zonen-Prüfung im Runner** (Ablehnung bei Verstoß): Zone liegt im Projekt; Zone liegt **nicht** unter `%TEMP%`/`%TMP%`; Zone existiert; keine Verschachtelung mit einer aktiven Zone; keine Reparse Points (Symlinks/Junctions/Hardlinks) innerhalb der Zone; Zone ist weder das Projekt-Root noch `.tandem/` selbst und enthält weder `.git/` noch die Tandem-Zustandsdateien (`state.json`, `lock`, `ledger.md`, `prompts/`, `replies/`, `plans/`, `workers/`) noch gemeinsame Build-/Cache-Ordner (`node_modules`, `dist`, `build`, `.next`, `target`); Pfade werden kanonisiert und case-insensitiv verglichen. Ausdrücklich erlaubt sind die Galerie-Zonen `.tandem/design/<N>/codex/` und `src/tandem-lab/<N>/codex/` (4.6). Max. **2** aktive Worker.
- **Regeln:** Claude fasst eine aktive Zone nicht an. Worker committen nie und ändern keine gemeinsamen Builds/Caches (im Brief verboten; außerhalb der Zone durch die Sandbox verhindert).
- **Rückgabe** nach `worker-result.schema.json`. Claude verifiziert den **echten Diff** (Git: `git status`/`git diff -- <zone>`; ohne Git: Dateiliste + Hashes vor/nach), führt die Tests aus, integriert, und macht einen Begleiter-Checkpoint zur Integration.

### 4.5 Abschluss: zwei unabhängige Urteile
1. **Dauer-Thread** (`contact --kind final`, Effort medium, high bei Security/Daten/Concurrency): prüft Zieltreue, Umsetzung angenommener Einwände, offene Punkte.
2. **Frischer Diff-Review** (`review --uncommitted` bzw. `--base`, ohne Gesprächsbias): ein frischer `codex exec`-Thread mit Review-Vertrag liest den Diff selbst und sucht echte Bugs (nicht `codex exec review`, das das Ausgabeschema ignoriert); ein Schema-Retry resumiert diesen Thread. Ohne Git: `contact --kind final` mit Dateiliste und Diff-Auszug.
Claude führt beide Ergebnisse mit Fix-Disposition im Ledger zusammen und fixt echte Bugs selbst. Greift zusammen mit `superpowers:verification-before-completion`. Ersetzt den Duofold-/Trifold-Abschluss-Bug-Check, solange tandem aktiv ist.

### 4.6 Design-Galerie (`/tandem design <thema> [--vite]`)
Für UI-Arbeit bauen **beide** je eine Variante; der Nutzer vergleicht sie nebeneinander im Browser und wählt. Zwei Betriebsarten:

**Standalone** (jedes Projekt): Varianten sind eigenständige HTML-Seiten (inline CSS/JS oder CDN-Tailwind) unter `.tandem/design/<N>/claude/index.html` und `.tandem/design/<N>/codex/index.html`. Der Runner serviert sie über den **Tandem-Server** (Node `http`, ohne Abhängigkeiten, nur `127.0.0.1`, Standard-Port 4747, gestartet mit `serve`): `/design` listet die Runden, `/design/<N>` zeigt beide Varianten als beschriftete iframes nebeneinander (Umschalter split/stack/vollbild), darunter die Kritik-Notizen aus `notes.md` je Variante; `/files/…` liefert statische Dateien unterhalb von `.tandem/design/` mit Path-Traversal-Schutz und Content-Types für html/css/js/json/svg/png/jpg/webp/woff2. Derselbe Server trägt das Board (4.7).

**Vite-Route** (Vite + React/TS, vom Runner an `vite.config.*` und `react` in `package.json` erkannt, sonst Fehler mit Hinweis auf Standalone): Varianten sind Komponenten **im Projekt** unter `src/tandem-lab/<N>/claude/index.tsx` und `src/tandem-lab/<N>/codex/index.tsx` (je `export default`), damit Projekt-Styles, Tailwind-Config und vorhandene Komponenten nutzbar sind. Der Runner legt einmalig einen **zusätzlichen Vite-Einstieg** `tandem-lab.html` im Projekt-Root plus `src/tandem-lab/main.tsx` an; Vite serviert weitere Root-HTML-Dateien im Dev-Server automatisch unter `/tandem-lab.html`, ohne Router-Änderung. Die Galerie findet Varianten per `import.meta.glob('./*/{claude,codex}/index.tsx')` selbst und zeigt Notizen via `?raw`-Import. Den Dev-Server startet nicht der Runner, sondern Claude Code (`preview_start` mit `launch.json`) oder der Nutzer. `src/tandem-lab/` und `tandem-lab.html` werden in `.gitignore` eingetragen.

**Ablauf einer Runde**
1. Claude schreibt den **Design-Brief** (`brief.md`): Aufgabe, Nutzer, Constraints, Stack, Stilvorgaben des Nutzers (aus Memory/Projekt, z. B. dunkle Themes, Glassmorphism, polierte Animationen, kein Pill-Design), Dateikonventionen, Output-Cap.
2. `design start` legt die Runde an und startet den **Codex-Worker** mit Zone = Codex-Ordner (workspace-write, Effort medium, Deadline 20 min). Claude baut parallel die eigene Variante (`frontend-design`/`ui-ux-pro-max` nach Bedarf).
3. **Gegenseitige Kritik** (optional, Sparring-Kontakt): Codex bewertet Claudes Variante über den Thread, Claude bewertet Codex' Variante; beide Notizen landen als `notes.md` neben der jeweiligen Variante und erscheinen in der Galerie.
4. Galerie zeigen: Standalone über den Tandem-Server (`serve`), Vite über den laufenden Dev-Server; Claude öffnet die URL im Browser-Pane und liefert dem Nutzer einen Screenshot plus Link.
5. Der Nutzer wählt **A, B oder Mischung** (Freitext). `design finish --pick` speichert die Entscheidung (`decision.json` + Ledger). Bei „Mischung" folgt Runde N+1 mit präzisiertem Brief; sonst integriert Claude die gewählte Variante ins Projekt (Begleiter-Checkpoint). Bei Vite räumt `design finish --cleanup` `src/tandem-lab/` und `tandem-lab.html` weg, nachdem die Wahl integriert ist; Standalone-Runden bleiben lokal unter `.tandem/design/`.

**Regeln:** Die Codex-Zone ist ausschließlich der eigene Variantenordner. Keine Variante berührt Projektdateien außerhalb ihres Ordners; Integration macht nur Claude. Der Tandem-Server bindet nur an localhost und wird bei `serve stop`, `stop` oder Deadline (Standard 4 h) beendet.

### 4.7 Tandem-Board (`/tandem board`)
Eine **read-only Zeitleiste** des Austauschs zwischen Claude und Codex im Browser, damit der Nutzer live zuschauen kann, was die beiden verhandeln (Geist des Roundtable, nur im Browser statt im Chat). Route `/board` auf dem Tandem-Server; Daten kommen ausschließlich aus `.tandem/` (state.json, prompts/, replies/, plans/, workers/, design/), nichts wird geschrieben.

**Inhalt:** Kopfzeile mit Projekt, Thread-Kurz-ID, Modus, pausiert/aktiv, Kontakt-Zahl, Token-Verbrauch gesamt und je Art. Darunter die Zeitleiste, neueste oben: je Kontakt Art, Zeit, Dauer, Effort, Verdict-Badge (OK/CONCERN/BLOCK bzw. APPROVE/REVISE), aufklappbar mit dem gesendeten Umschlag (Prompt-Datei) und der Antwort-JSON als lesbare Liste (Punkte mit Schwere, Datei:Zeile, Geprüftes, Restrisiko). Planrunden zeigen Runde, Hash und Matrix. Worker zeigen Zone, Status, Deadline, Ergebnis. Design-Runden verlinken auf die Galerie und zeigen die Entscheidung. Einwände aus dem Ledger erscheinen in einem Seitenkasten mit Status offen/angenommen/abgelehnt/zurückgestellt (aus `ledger.md`, Abschnitt „Einwände", parsebar per fester Zeilenform `- [C12-2] offen|angenommen|abgelehnt|zurückgestellt: Text`).

**Technik:** Server rendert serverseitig einfaches HTML mit inline CSS (dunkles Theme), Auto-Refresh alle 5 s per `fetch` auf `/board.json`; keine externen Abhängigkeiten, keine CDN-Skripte. Claude öffnet das Board bei `/tandem board` im Browser-Pane.

---

## 5. Lebenszyklus und Befehle

| Nutzer-Trigger | Wirkung |
|----------------|---------|
| `/tandem` | ohne `.tandem/`: Start (Onboarding, Thread anlegen). Mit `.tandem/`: Status + Resume-Kontakt („seit Baseline passiert: …" aus Ledger + Git-Log, Effort low). |
| `/tandem begleiter` `plan` `sparring` `split` | Modus setzen (Begleiter ist Standard). |
| `/tandem check` | Checkpoint auf Zuruf. |
| `/tandem frag <text>` | Sparring-Kontakt. |
| `/tandem lane <art> <thema>` | Fork-Lane. |
| `/tandem worker <zone> <auftrag>` | Worker starten (Split-Modus). |
| `/tandem design <thema> [--vite]` | Design-Runde starten (4.6): Brief, Codex-Worker, eigene Variante, Galerie. |
| `/tandem design zeigen` / `/tandem design wahl <A\|B\|mix> [Notiz]` | Galerie öffnen / Entscheidung festhalten, ggf. nächste Runde oder Integration. |
| `/tandem board` | Tandem-Server starten (falls nötig) und das Board im Browser-Pane öffnen (4.7). |
| `/tandem status` | Zustand: Thread, Modus, Kontakte, Plan-Runde, Worker (PID-Prüfung), offene Einwände aus dem Ledger. |
| `/tandem pause` / `/tandem weiter` | Checkpoints aussetzen / wieder aktivieren. |
| `/tandem rotate` | Neuer Thread mit Ledger-Seed (≤ 2.000 Wörter: Entscheidungen, offene Risiken, aktueller Stand). |
| `/tandem stop` | tandem für dieses Projekt beenden (Zustand bleibt, Thread bleibt auf der Platte). |

**Rotation** schlägt Claude selbst vor: am sauberen Phasenende nach ~40 Kontakten, oder wenn Codex dem Ledger zweimal widerspricht (Gedächtnisfehler). Alte Thread-IDs wandern in `state.history`.

**Session-Ende:** nichts zu tun. Threads persistieren, Worker haben Deadlines, verwaiste Worker meldet `status` per PID-Prüfung beim nächsten Mal.

### Runner-Unterbefehle
| Befehl | Kern-Optionen | Ergebnis |
|--------|---------------|----------|
| `doctor` | — | codex vorhanden, Version, Login-Status, Node-Version, Projekt nicht in TEMP; speichert Codex-Version |
| `start` | `--summary-file <abs>` `[--effort medium]` | legt `.tandem/` an, startet Thread, `{threadId, replyPath}` |
| `contact` | `--kind checkpoint\|resume\|final\|sparring` `--prompt-file <abs>` `[--effort]` `[--deadline-min]` | Resume-Kontakt, `{contactId, verdict…, replyPath, durationMs}` |
| `plan-round` | `--round 1..3` `--plan-file <abs>` `[--matrix-file <abs>]` | Planrunde mit `plan-verdict`; Runde 4 → Fehler |
| `lane` | `--kind gegenposition\|premortem\|alternative` `--prompt-file <abs>` | Fork-Lane, `sparring`-JSON |
| `worker start` | `--zone <abs>` `--brief-file <abs>` `[--effort]` `[--deadline-min 20]` | Zonen-Prüfung, detached Start, `{workerId, pid, deadlineAt}` |
| `worker status [id]` / `worker wait <id>` / `worker cancel <id>` | — | Status, Warten bis Ergebnis/Deadline, Abbruch |
| `review` | `--uncommitted \| --base <ref> \| --commit <sha>` `[--effort]` `[--title]` | frischer `codex exec review`, `verdict`-JSON; ohne Git → Fehler mit Hinweis auf `contact --kind final` |
| `design start` | `--topic <t>` `--brief-file <abs>` `[--vite]` `[--effort medium]` `[--deadline-min 20]` | Runde N anlegen (Standalone unter `.tandem/design/<N>/`, Vite unter `src/tandem-lab/<N>/` + Einstieg), Codex-Worker in der Codex-Zone starten, `{round, paths, workerId}` |
| `serve` / `serve stop` | `[--port 4747]` `[--deadline-h 4]` | Tandem-Server (Board + Galerie) detached starten, PID und URL in state / beenden |
| `design status` | `[--round N]` | Runden, Varianten vorhanden ja/nein, Worker-Status, Server-URL |
| `design finish` | `--round N` `--pick claude\|codex\|mix` `[--note <text>]` `[--cleanup]` | `decision.json` schreiben; `--cleanup` entfernt Vite-Lab-Dateien |
| `mode <m>` / `pause` / `unpause` / `stop` | — | Zustand setzen |
| `config` | `--min-remaining <prozent>` | Schwelle des Nutzungs-Wächters dauerhaft setzen (Standard 10) |
| `rotate` | `--seed-file <abs>` | neuer Thread, alter in History |
| `status` | `[--human]` | Zustandszusammenfassung inkl. Token-Verbrauch (gesamt, je Art, diese Session) und Server-URL |

Alle Befehle: `--project <abs>` optional (default: cwd), Ausgabe eine JSON-Zeile, Exitcode 0/1. Env `TANDEM_CODEX_BIN` überschreibt das `codex`-Binary (Tests).

---

## 6. Fehlerbehandlung

| Fall | Erkennung | Fallback |
|------|-----------|----------|
| Thread nicht resumierbar (Codex-Update, Session gelöscht) | Exit ≠ 0 + Fehlertext des Resume | Runner meldet `error: thread_lost`; Claude schreibt Seed aus Ledger, `rotate`; Vermerk im Ledger |
| Restnutzung unter Schwelle | Vorab-Abfrage `account/rateLimits/read` vor jedem Lauf | `error: quota_low` mit Fenster, Rest-Prozent und Reset-Zeit; **kein** Codex-Aufruf, keine Pause (nach dem Reset geht es automatisch weiter); Claude informiert den Nutzer und arbeitet ohne Kontakt weiter oder wartet; `--min-remaining 0` erzwingt |
| Limit/Quota erreicht (trotz Wächter) | Fehlertext (Rate-Limit/Usage-Limit) in stderr/JSONL | `state.paused = true`, `error: quota`; Claude informiert den Nutzer, arbeitet ohne Checkpoints weiter, Ledger „degradiert seit …" |
| Hängender Prozess | Deadline je Kontakt-Typ überschritten | Prozessbaum beenden, Kontakt „timeout"; bei Workern Diff prüfen; **ein** manueller Neuversuch, nie blind wiederholen |
| Ungültige Antwort trotz Schema | Runner-Validierung | ein Wiederholungsversuch mit Schema-Hinweis, sonst „failed" |
| Codex-Version gewechselt | `doctor` und `start` vergleichen mit `state.codexVersion` | Vermerk (`versionChanged`) + Smoke-Kontakt (Effort low) |
| Zustand beschädigt | JSON-Parse-Fehler | Runner bricht ab, `error: state_corrupt`, Hinweis auf `state.json.bak` (der Runner hält eine Sicherung des letzten gültigen Zustands) |
| Veralteter Lock | PID nicht mehr lebend oder Lock älter als 30 min | Lock entfernen, weiter |
| Verwaister Worker | PID tot, kein `result.json` | Status „orphaned"; Claude prüft Diff der Zone |

Der Runner wiederholt **nie** selbstständig Codex-Aufrufe (Kosten). Jeder Fehler nennt einen `hint` für Claude.

---

## 7. Kosten, Effort, Deadlines

| Kontakt | Effort | Deadline |
|---------|--------|----------|
| Checkpoint klein (≤ 3 Dateien) | low | 5 min |
| Checkpoint groß, vor „fertig" | medium | 8 min |
| Resume-Kontakt | low | 5 min |
| Plan Runde 1 | high | 15 min |
| Plan Runden 2–3 | medium | 10 min |
| Sparring, Lane | medium | 8 min |
| Worker | medium; high bei Security/Migration | 20 min |
| Design-Worker (Variante) | medium | 20 min |
| Design-Kritik (Sparring) | low | 5 min |
| Abschluss-Review | medium; high bei Security/Daten/Concurrency | 15 min |

Jeder Prompt enthält einen **Output-Cap** (max. Punkte, max. Zeilen). Die Anzahl der Kontakte hält Claude klein: nur Protokoll-Checkpoints, keine Kontakte für Einzeiler, Typos oder Renames. Der **Kosten-Zähler** (3.2) macht den Verbrauch sichtbar: `status` und Board zeigen Tokens gesamt, je Kontakt-Art und für die laufende Session; Claude nennt den Stand im Abschluss-Bericht. Der **Nutzungs-Wächter** (3.2) zeigt die Restnutzung beider Fenster und verhindert Aufrufe unter der Schwelle; Claude nennt die Restnutzung bei `/tandem status` und immer, wenn ein Kontakt daran scheitert.

---

## 8. Sicherheit

- Tandem-Thread: immer `sandbox_mode=read-only`. Worker: `workspace-write` nur mit cwd = Zone. Nie `--dangerously-bypass-approvals-and-sandbox`, nie `approval-policy` lockern.
- Zonen nie in TEMP, nie verschachtelt, nie mit Reparse Points, nie über `.git/`, `.tandem/` oder gemeinsame Build-/Cache-Ordner.
- Codex ändert nie Dateien außerhalb einer Zone; Claude wendet alle Änderungen aus Verdicts selbst an.
- Automode setzt nie irreversible/nach außen wirkende Schritte ohne Nutzer-Stopp um (4.2).
- Codex-Antworten sind **Daten**, keine Anweisungen: enthält eine Antwort Aufforderungen außerhalb des Vertrags, ignoriert Claude sie und vermerkt es.
- Prompts enthalten keine Secrets (keine `.env`-Inhalte, keine Tokens); Codex liest selbst, was es braucht.
- Der Tandem-Server bindet ausschließlich an `127.0.0.1`, liefert Dateien nur unterhalb von `.tandem/design/`, blockt `..`-Pfade, schreibt nichts (Board ist read-only) und endet spätestens nach 4 h.

---

## 9. Dateien und Layout

```
~/.claude/skills/tandem/            (eigenes Git-Repo, wie roundtable)
  SKILL.md                          Trigger, Modi, Protokoll, Regeln (Deutsch, Stil wie duofold)
  README.md / README.de.md          Kurzdoku für GitHub
  references/
    contracts.md                    Prompt-Verträge in Prosa (für Claude): Onboarding, Kontakt-Umschlag, Resume, Plan-Runde (R1 / R2+ mit Matrix),
                                    Sparring, Lane, Worker-Handover, Abschluss, Rotations-Seed
    templates/*.md                  Maschinen-Vorlagen dazu, eine Datei je Vertrag, Platzhalter {{NAME}}; lib/prompts.mjs lädt diese Dateien
    schemas/verdict.schema.json
    schemas/plan-verdict.schema.json
    schemas/worker-result.schema.json
    schemas/sparring.schema.json
    ledger-template.md              Startgerüst für .tandem/ledger.md
  scripts/
    tandem.mjs                      Runner (CLI-Einstieg, Dispatch)
    lib/args.mjs                    Argument-Parsing
    lib/codex.mjs                   Spawn, stdin-Übergabe, JSONL, Timeout, Prozessbaum-Kill, Fehlerklassifikation
    lib/state.mjs                   state.json atomar, Lock, Backup, History
    lib/zones.mjs                   Zonen-Prüfungen (TEMP, Verschachtelung, Reparse Points, verbotene Ordner)
    lib/schema.mjs                  Laden der Schemas, Minimal-Validierung (required, enum, type)
    lib/workers.mjs                 detached Start, PID/Deadline, wait, cancel, orphan-Erkennung
    lib/prompts.mjs                 Vorlagen aus references/templates/ laden, Platzhalter füllen
    lib/design.mjs                  Design-Runden: Ordner, Vite-Erkennung, Lab-Einstieg scaffolden, decision.json, cleanup
    lib/usage.mjs                   Token-Verbrauch aus JSONL/stderr lesen, in state.usage summieren
    lib/ratelimits.mjs              Restnutzung über `codex app-server` (account/rateLimits/read) lesen, Schwelle prüfen (quota_low)
    lib/exchange.mjs                gemeinsamer Ablauf eines Thread-Kontakts: Wächter, Resume-Aufruf, Schema-Prüfung, ein Retry, Zustand
    lib/server.mjs                  Tandem-Server (http, localhost): /board, /board.json, /design, /design/<N>, /files, Traversal-Schutz, Deadline
    lib/board.mjs                   Board-Daten aus .tandem/ sammeln (Kontakte, Planrunden, Worker, Design, Einwände aus ledger.md)
  references/templates/
    design-brief.md                 Vorlage Design-Brief (inkl. Stilvorgaben-Block)
    tandem-lab.html                 Vite-Einstieg
    tandem-lab-main.tsx             Galerie-App (import.meta.glob, split/stack/vollbild, Notizen via ?raw)
    gallery.html                    Seitengerüst der Standalone-Galerie
    board.html                      Seitengerüst des Boards (dunkles Theme, inline CSS, 5-s-Refresh)
  tests/
    fake-codex.mjs                  simuliert `codex exec|resume|fork|review` (JSONL, -o, Schemas, Hang, Fehler, Quota)
    *.test.mjs                      node --test
  docs/2026-09-06-tandem-design.md  dieses Dokument
```

**Onboarding-Prompt** (Vertrag, Kurzfassung): Rolle „pragmatischer Pairing-Partner, kein Rubber-Stamp"; Regeln: erst lesen, dann urteilen; nennen, was geprüft wurde; Schwere-Definitionen (BLOCKER = falsch/unsicher/Datenverlust, MAJOR = Korrektheits-/Scope-Lücke, MINOR = Verbesserung); Deutsch; keine Skill-Rituale, direkt antworten; max. 5 Punkte; Antwort strikt nach Schema.

---

## 10. Tests

- **Unit/Integration** (`node --test tests/`), mit `TANDEM_CODEX_BIN` auf `fake-codex.mjs`:
  - `start` erfasst die Thread-ID aus JSONL, legt `.tandem/` an, ergänzt `.gitignore` in Git-Repos.
  - `contact` baut die korrekten Argumente (Fake protokolliert argv), übergibt den Prompt per stdin, validiert Schema, zählt Kontakte.
  - `plan-round` erzwingt max. 3 Runden, speichert Plan-Hash, wählt Effort je Runde.
  - Timeout: Fake hängt → Runner beendet Prozessbaum innerhalb der Deadline, Status „timeout".
  - Zonen: TEMP, verschachtelt, Reparse Point, verbotener Ordner, außerhalb Projekt → Ablehnung mit klarem Fehler.
  - Worker: Start detached, `status` erkennt lebend/tot/orphaned, `wait` liefert Ergebnis, `cancel` beendet.
  - Zustand: atomares Schreiben, Backup, Lock (lebend/veraltet), Rotation mit History.
  - Fehlerklassifikation: `thread_lost`, `quota`, `invalid_output`.
  - Design: `design start` legt Ordner/Brief an und startet den Worker in der Codex-Zone; Vite-Erkennung (mit/ohne `vite.config.*`); Lab-Einstieg wird nur einmal erzeugt; `finish --cleanup` entfernt nur Lab-Dateien; `.gitignore`-Einträge.
  - Tandem-Server: liefert Galerie-Index und Rundenseite, blockt `..`-Pfade, setzt Content-Types, bindet nur an localhost, `serve stop` beendet den Prozess.
  - Board: `/board.json` bildet Kontakte, Planrunden, Worker, Design-Runden und Ledger-Einwände korrekt ab (Fixture-`.tandem/`); `/board` rendert ohne externe Ressourcen.
  - Kosten-Zähler: `turn.completed`-Usage wird summiert; stderr-Fallback parst `57.717` (de-DE) und `57,717` (en-US) beide zu 57717.
  - Nutzungs-Wächter: Fake-App-Server liefert einstellbare `usedPercent`; unter der Schwelle bricht `contact` mit `quota_low` ab, ohne den Fake-`exec` aufzurufen; `--min-remaining 0` erzwingt; Abfragefehler blockiert nicht.
- **Smoke** gegen echtes Codex (Effort low), nur auf Zuruf: `start` → `contact` → `lane` → `review` in einem Wegwerf-Projekt außerhalb von TEMP.
- **Skill-Probelauf** vor „fertig": ein kleines echtes Feature in einem Beispielprojekt durch Start, Checkpoint, Planrunde, Worker, Abschluss.

---

## 11. Integration

- **CLAUDE.md** (global) bekommt einen Eintrag nach dem Muster der anderen Skills: Trigger `/tandem`, Kurzbeschreibung, Hinweis „Kontakte nur nach Protokoll", und ein einmaliges Auto-Angebot zu Beginn einer mehrstufigen Feature-Arbeit in einem Projekt (nicht bei Einzeiler-Fixes, nicht bei Q&A; bei Ablehnung in der Session nicht erneut).
- **Duofold/Trifold:** bleiben für Einzelprüfungen ohne aktives tandem. Bei aktivem tandem übernimmt tandem den Abschluss-Bug-Check.
- **OpenAI-Codex-Plugin:** unangetastet; sein Stop-Gate bleibt aus. `/codex:rescue` und tandem-Worker nutzen unterschiedliche Threads.
- **Memory:** nach der Implementierung ein Projekt-Memory-Eintrag (Skill-Ort, Stand, offene Punkte).

---

## 12. Bei der Implementierung zu verifizieren

1. ~~`codex exec review --uncommitted` zusammen mit `--output-schema` und `-o`~~ **Geklärt 2026-09-06 (Dogfooding):** `codex exec review` ignoriert `--output-schema`, die Endnachricht ist Prosa. Der Abschluss-Review läuft daher als frischer `codex exec`-Thread mit eigenem Review-Vertrag (`templates/review.md`), der den echten Diff selbst per `git diff` liest, und dem `verdict`-Schema; ein Schema-Retry resumiert diesen Review-Thread.
2. `codex exec fork --ephemeral`: Lane wird nicht persistiert, Hauptthread bleibt unverändert.
3. Exakter Fehlertext bei Limit/Quota und bei nicht auffindbarem Thread (für die Klassifikation).
4. Detached Worker unter Windows: Start via `cmd /c` mit stdin-Redirect aus der Brief-Datei, `detached: true`, `unref()`; Prozessbaum-Kill per `taskkill /T /F`.
5. Verhalten von `-C` in Kombination mit relativem `-o` (wir nutzen ohnehin nur absolute Pfade).
6. Reparse-Point-Erkennung per `fs.lstat` (Symlink/Junction); Hardlinks sind unter Windows nicht sicher erkennbar → als bekanntes Restrisiko dokumentieren.
7. Vite: zusätzliche Root-HTML-Datei wird im Dev-Server ohne Config-Änderung serviert; `import.meta.glob` mit Klammer-Muster für die Varianten; `?raw`-Import der Notizen. Bei Projekten mit `appType: 'spa'`-Fallback oder eigenem `root` ggf. Pfad anpassen.
8. Codex-Worker in der Vite-Zone kann `node_modules` des Projekts lesen (Typen, Komponenten), aber nicht schreiben; prüfen, dass Type-Checks/Imports aus der Zone heraus funktionieren.
9. Exaktes Format der Usage-Angaben: Felder im JSONL-Event `turn.completed` (`usage.input_tokens`, `usage.output_tokens`, ggf. cached) und die `tokens used`-Zeile auf stderr (beobachtet: `tokens used` gefolgt von `57.717` unter de-DE).

---

## 13. Umsetzungsreihenfolge (Vorlage für den Implementierungsplan)

1. **Runner-Kern:** `args`, `state` (atomar, Lock, Backup), `codex` (Spawn, stdin, JSONL, Timeout, Prozessbaum-Kill, Fehlerklassifikation), `schema`, `usage` (Kosten-Zähler); Befehle `doctor`, `start`, `contact`, `status`, `mode`, `pause`, `unpause`, `stop`, `rotate`. Fake-Codex + Tests.
2. **Plan und Abschluss:** `plan-round`, `review`; Schemas `plan-verdict`, `verdict`.
3. **Worker und Zonen:** `zones`, `workers` (detached, wait, cancel, orphan), Schema `worker-result`.
4. **Sparring und Lanes:** `contact --kind sparring`, `lane`; Schema `sparring`.
5. **Tandem-Server, Board und Design-Galerie Standalone:** `serve`, `/board` + `/board.json`, `design start|status|finish`, Galerie-Routen, Vorlagen.
6. **Design-Galerie Vite:** Erkennung, Lab-Einstieg, `--cleanup`.
7. **Skill-Texte:** `SKILL.md`, `contracts.md`, `ledger-template.md`, README, CLAUDE.md-Eintrag, Memory-Eintrag.
8. **Abnahme:** Smoke gegen echtes Codex (Effort low), Skill-Probelauf in einem Beispielprojekt, Abschluss-Bug-Check per Duofold auf dem echten Diff.

---

## 14. Entscheidungs-Log

**Nutzer (Sophey), 2026-09-06**
- Modi v1: Begleiter, Plan-Konsens mit Automode, Sparring, Arbeitsteilung.
- Automode: Auto bei Konsens, Nutzer entscheidet bei Dissens nach 3 Runden.
- Arbeitsteilung: Schreib-Zonen, per Sandbox erzwungen.
- Kontakte nur per Protokoll, keine Hooks.
- Name `tandem`, Trigger `/tandem`, Ledger `.tandem/`.
- Runner: ja (Node, ohne Abhängigkeiten).
- Abschnitte 1–3 des Designs freigegeben.
- Design-Galerie in v1: Standalone-Galerie **und** Vite-Route (Idee des Nutzers: „kleiner Vite-Server, um sich verschiedene Designs von euch beiden anzuschauen").
- Kosten-Zähler und Tandem-Board in v1 (Vorschlag Claude, Nutzer: „passt").
- Nutzungs-Wächter in v1 (Frage des Nutzers: Restnutzung sehen und bei 0 % nicht mehr auf Codex zugreifen); `account/rateLimits/read` am 2026-09-06 verifiziert.
- Spec freigegeben; nächster Schritt writing-plans, danach Duofold-Prüfung des Plans.

**Codex-Review (Duofold, Modus idee, Standard), eingearbeitet**
- Kanal A bestätigt; B und C verworfen bzw. auf v2 verschoben.
- JSON-Verdicts per `--output-schema` (verifiziert, strict-Schema nötig); frischer Diff-Review via `codex exec review` (verifiziert).
- Eigener Planungsfluss statt Brainstorming-Gate im Plan-Modus.
- Anti-Sycophancy-Kriterien, Eingaben je Planrunde, Kontakt-Umschlag, Rotation (~40 Kontakte / 2 Gedächtnisfehler, Seed ≤ 2.000 Wörter).
- Worker-Handover-Pflichtfelder, strukturierte Rückgabe, Windows-Zonenrisiken (Reparse Points, Verschachtelung, Builds/Caches, absolute Pfade).
- Fehler-/Effort-Policy; Runner als Control-Plane; Fork-Lanes; zwei Abschlussurteile.
