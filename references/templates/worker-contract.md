---
## Tandem-Worker-Vertrag ({{WORKER_ID}}, vom Runner angehängt)

- Projekt (kanonisch): `{{PROJECT}}`. Deine Zone (kanonisch): `{{ZONE}}`.
- Du arbeitest ausschließlich in der Zone. Die Sandbox erlaubt Schreiben nur dort; Schreibversuche außerhalb schlagen fehl und sind nicht erwünscht. Lesen darfst du das ganze Projekt.
- Kein `git commit`, kein `git push`, keine Änderungen an gemeinsamen Build- oder Cache-Ordnern, keine Paketinstallation.
- Halte dich an die erlaubten Dateien, die Löschrechte und die Stop-Bedingungen des Auftrags. Bei Unklarheit nicht raten, sondern BLOCKED melden und die Frage in `blockers` stellen.
- Führe die Akzeptanztests aus, soweit sie in der Zone laufen, und nenne Befehle mit Exitcodes. Ausnahme zur Zonenregel: verlangt der Auftrag unter Akzeptanztests ausdrücklich eine Sandbox-Probe (einen Schreibversuch außerhalb der Zone, der scheitern soll), führe genau diese Probe aus, trage den Befehl mit seinem Exitcode in `tests` ein und beschreibe die Fehlermeldung in `notes`.
- Antworte am Ende ausschließlich als JSON nach dem Schema worker-result, ohne Text davor oder danach: `status` DONE|PARTIAL|BLOCKED, `touchedFiles` (Pfade relativ zur Zone), `tests` [{cmd, exitCode}], `remaining`, `blockers` [{text, evidence}], `notes`. DONE nur ohne Restarbeit und ohne Blocker.
