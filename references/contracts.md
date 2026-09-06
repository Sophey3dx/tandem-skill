# Tandem-Verträge (Kern)

Maschinen-Vorlagen liegen in `templates/`; dieses Dokument erklärt, was jeder Vertrag leistet und was Claude liefern muss.

## Onboarding (`templates/onboarding.md`)
Startet den Thread. Claude liefert `PROJECT_SUMMARY` (Stack, Konventionen, Ziele, Nicht-Ziele, Pfade, ≤ 40 Zeilen). Codex bestätigt in ≤ 5 Zeilen ohne JSON. Enthält Rolle, Schweregrade und Anti-Sycophancy-Regeln; gilt für den ganzen Thread. Bei Rotation dieselbe Vorlage mit Ledger-Seed als `PROJECT_SUMMARY` und `EXTRA`-Hinweis.

## Kontakt-Umschlag (`templates/contact.md`)
Der Runner hüllt Claudes Prompt-Datei (`BODY`) in Kontakt-ID, Art, Schema-Name und Output-Cap. Claude liefert im Body: Baseline, geänderte Pfade, Delta, Testbelege, Einwände-Matrix, genau eine Prüffrage. Antwort nach `schemas/verdict.schema.json`: `verdict OK|CONCERN|BLOCK`, `checked`, `points[{id,severity,text,file,line}]` (≤ 5), `residualRisk`. Punkt-IDs `C<n>-<k>`.

## Planrunde (`templates/plan-round.md`, `templates/plan-matrix.md`)
Runde 1 bekommt den vollen Plan (Effort high), Runden 2–3 den vollen überarbeiteten Plan plus Matrix (`Einwand-ID → accepted|rejected|deferred + Grund`). Antwort nach `schemas/plan-verdict.schema.json`: `verdict APPROVE|REVISE`, `criteria{blockersOpen,sourcesRead,testStrategyFeasible,residualRisk}`, `points[{id,severity,category,text,section,newEvidence}]` (≤ 8). Konsens berechnet der Runner: APPROVE, `blockersOpen = 0`, Quellen gelesen, Teststrategie machbar, Restrisiko benannt, kein BLOCKER/MAJOR-Punkt.

## Abschluss (`templates/review.md`)
Zwei Urteile: `contact --kind final` (Thread, Zieltreue) und `review` (frischer `codex exec`-Thread mit Review-Vertrag; liest den Diff selbst per `git diff`, sucht echte Bugs, keine Stilkommentare; genau ein Schema-Retry per Resume dieses Threads). Beide nach `verdict`-Schema; Review-Punkte heißen `R-1`, `R-2`, …

## Sparring (`templates/contact.md` mit Schema sparring)
Freie Frage mit Kontext im Body. Antwort nach `schemas/sparring.schema.json`: `position`, `reasons` (≤ 8), `checked`, `risks` (≤ 8), `recommendation`; `position` und `recommendation` dürfen nicht leer sein.

## Lane (`templates/lane.md`)
Ephemerer Fork des Threads mit einer von drei Anweisungen (Gegenposition, Premortem, Alternative) und Claudes Thema. Antwort nach `sparring`-Schema. Ein Schema-Retry forkt erneut mit Hinweis.

## Worker-Handover (`templates/worker-brief.md` von Claude + `templates/worker-contract.md` vom Runner)
Claude liefert Auftragstyp, Baseline, Ziel, Nicht-Ziele, erlaubte Dateien, Schnittstellen, Akzeptanztests, Löschrechte, Stop-Bedingungen und Ledger-Auszug (alle Pflicht, der Runner prüft die Überschriften). Der Runner hängt den Vertrag an (kanonischer Projekt- und Zonenpfad, nur Zone, kein Commit, keine Caches, BLOCKED statt raten; eine vom Auftrag ausdrücklich verlangte Sandbox-Probe ist erlaubt). Rückgabe nach `schemas/worker-result.schema.json`: `status DONE|PARTIAL|BLOCKED`, `touchedFiles`, `tests[{cmd,exitCode}]`, `remaining`, `blockers[{text,evidence}]`, `notes`; DONE nur ohne Restarbeit und Blocker. Ein ungültiges Ergebnis wird genau einmal per read-only Resume des Worker-Threads nachgefordert.

## Antwort-Regeln für Codex (in allen Vorlagen)
Deutsch, knapp, erst lesen, dann urteilen, `checked` ehrlich füllen, keine Skill-Rituale, ausschließlich JSON wenn ein Schema vorgegeben ist.
