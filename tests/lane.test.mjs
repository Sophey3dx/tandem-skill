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
