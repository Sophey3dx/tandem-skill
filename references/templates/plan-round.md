# Tandem-Planrunde {{ROUND}} von 3 (Plan-Hash {{PLAN_HASH}})

Claude legt dir den vollständigen aktuellen Plan vor. Lies ihn ganz und lies die darin referenzierten Dateien, bevor du urteilst.

{{MATRIX_BLOCK}}

## Plan
{{PLAN}}

## Urteilskriterien
- APPROVE nur wenn: keine offenen BLOCKER oder MAJOR (criteria.blockersOpen = 0), du die referenzierten Quellen gelesen hast (sourcesRead = true), die Teststrategie machbar ist (testStrategyFeasible = true) und du ein Restrisiko benennst.
- REVISE nur für Korrektheit, Sicherheit, Scope oder Prüfbarkeit. Ab Runde 2 brauchen neue Blocker neue Evidenz (newEvidence). Stilwünsche sind MINOR und blockieren nie.
- Punkte mit stabilen IDs P{{ROUND}}-1, P{{ROUND}}-2, … Maximal 8 Punkte, nach Schwere sortiert. Nenne je Punkt den Plan-Abschnitt (section).

Antworte ausschließlich als JSON nach dem Schema plan-verdict, ohne Text davor oder danach.
