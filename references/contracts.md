# Tandem-Verträge (Kern)

Maschinen-Vorlagen liegen in `templates/`; dieses Dokument erklärt, was jeder Vertrag leistet und was Claude liefern muss.

## Onboarding (`templates/onboarding.md`)
Startet den Thread. Claude liefert `PROJECT_SUMMARY` (Stack, Konventionen, Ziele, Nicht-Ziele, Pfade, ≤ 40 Zeilen). Codex bestätigt in ≤ 5 Zeilen ohne JSON. Enthält Rolle, Schweregrade und Anti-Sycophancy-Regeln; gilt für den ganzen Thread. Bei Rotation dieselbe Vorlage mit Ledger-Seed als `PROJECT_SUMMARY` und `EXTRA`-Hinweis.

## Kontakt-Umschlag (`templates/contact.md`)
Der Runner hüllt Claudes Prompt-Datei (`BODY`) in Kontakt-ID, Art, Schema-Name und Output-Cap. Claude liefert im Body: Baseline, geänderte Pfade, Delta, Testbelege, Einwände-Matrix, genau eine Prüffrage. Antwort nach `schemas/verdict.schema.json`: `verdict OK|CONCERN|BLOCK`, `checked`, `points[{id,severity,text,file,line}]` (≤ 5), `residualRisk`. Punkt-IDs `C<n>-<k>`.

## Planrunde (`templates/plan-round.md`, `templates/plan-matrix.md`)
Runde 1 bekommt den vollen Plan (Effort high), Runden 2–3 den vollen überarbeiteten Plan plus Matrix (`Einwand-ID → accepted|rejected|deferred + Grund`). Antwort nach `schemas/plan-verdict.schema.json`: `verdict APPROVE|REVISE`, `criteria{blockersOpen,sourcesRead,testStrategyFeasible,residualRisk}`, `points[{id,severity,category,text,section,newEvidence}]` (≤ 8). Konsens berechnet der Runner: APPROVE, `blockersOpen = 0`, Quellen gelesen, Teststrategie machbar, Restrisiko benannt, kein BLOCKER/MAJOR-Punkt.

## Abschluss
Zwei Urteile: `contact --kind final` (Thread, Zieltreue) und `review` (frischer `codex exec review`, Diff-Bugs). Beide nach `verdict`-Schema.

## Antwort-Regeln für Codex (in allen Vorlagen)
Deutsch, knapp, erst lesen, dann urteilen, `checked` ehrlich füllen, keine Skill-Rituale, ausschließlich JSON wenn ein Schema vorgegeben ist.
