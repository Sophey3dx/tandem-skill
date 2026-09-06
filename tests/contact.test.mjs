import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeProject, readLog, runTandem, startProject, writeFile } from "./helpers.mjs";

function prepared(name, env = {}) {
  const dir = makeProject(name);
  const logFile = path.join(dir, "fake.log");
  startProject(dir, { FAKE_THREAD_ID: "thread-1", ...env });
  const prompt = writeFile(dir, "delta.md", "Delta: Datei src/a.js geändert. Frage: Edge-Cases?");
  return { dir, logFile, prompt };
}

test("checkpoint contact resumes the thread with schema and returns the verdict", () => {
  const { dir, logFile, prompt } = prepared("contact");
  const { status, json } = runTandem(["contact", "--kind", "checkpoint", "--prompt-file", prompt], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(status, 0);
  assert.equal(json.contactId, "C1");
  assert.equal(json.verdict.verdict, "OK");
  assert.equal(json.attempts, 1);
  const call = readLog(logFile).find((c) => c.argv[0] === "exec" && c.argv[1] === "resume");
  assert.equal(call.argv[2], "thread-1");
  assert.ok(call.argv.includes("sandbox_mode=read-only"));
  assert.ok(call.argv.includes("model_reasoning_effort=low"));
  assert.ok(call.stdin.includes("Tandem-Kontakt C1 (checkpoint)"));
  assert.ok(call.stdin.includes("Delta: Datei src/a.js"));
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8"));
  assert.equal(state.contacts, 1);
  assert.equal(state.lastContact.kind, "checkpoint");
  assert.equal(state.usage.byKind.checkpoint.runs, 1);
  assert.ok(fs.existsSync(path.join(dir, ".tandem", "replies", "0001-checkpoint.json")));
});

test("invalid output triggers exactly one retry, then invalid_output", () => {
  const { dir, logFile, prompt } = prepared("retry");
  const { json } = runTandem(["contact", "--kind", "checkpoint", "--prompt-file", prompt], { cwd: dir, env: { FAKE_CODEX_LOG: logFile, FAKE_CODEX_MODE: "invalid_json" } });
  assert.equal(json.error, "invalid_output");
  const resumes = readLog(logFile).filter((c) => c.argv[1] === "resume");
  assert.equal(resumes.length, 2);
  assert.ok(resumes[1].stdin.includes("nicht schema-konform"));
});

test("paused blocks contacts unless --force; quota failure pauses", () => {
  const { dir, prompt } = prepared("paused");
  runTandem(["pause"], { cwd: dir });
  assert.equal(runTandem(["contact", "--kind", "checkpoint", "--prompt-file", prompt], { cwd: dir }).json.error, "paused");
  assert.equal(runTandem(["contact", "--kind", "checkpoint", "--prompt-file", prompt, "--force"], { cwd: dir }).json.ok, true);
  runTandem(["unpause"], { cwd: dir });
  const quota = runTandem(["contact", "--kind", "checkpoint", "--prompt-file", prompt], { cwd: dir, env: { FAKE_CODEX_MODE: "quota" } });
  assert.equal(quota.json.error, "quota");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8")).paused, true);
});

test("thread_lost and rate-limit guard are reported before or after the call", () => {
  const { dir, prompt, logFile } = prepared("lost");
  assert.equal(runTandem(["contact", "--kind", "final", "--prompt-file", prompt], { cwd: dir, env: { FAKE_CODEX_MODE: "thread_lost" } }).json.error, "thread_lost");
  const low = runTandem(["contact", "--kind", "final", "--prompt-file", prompt], { cwd: dir, env: { FAKE_USED_PRIMARY: "95", FAKE_CODEX_LOG: logFile } });
  assert.equal(low.json.error, "quota_low");
  assert.equal(readLog(logFile).filter((c) => c.argv[1] === "resume").length, 0);
  assert.equal(runTandem(["contact", "--kind", "final", "--prompt-file", prompt, "--min-remaining", "0"], { cwd: dir, env: { FAKE_USED_PRIMARY: "95" } }).json.ok, true);
});

test("resume contact starts a new session that includes itself; unknown kind rejected", () => {
  const { dir, prompt } = prepared("resume");
  runTandem(["contact", "--kind", "checkpoint", "--prompt-file", prompt], { cwd: dir });
  const resumed = runTandem(["contact", "--kind", "resume", "--prompt-file", prompt], { cwd: dir });
  assert.equal(resumed.json.usage.runs, 1);
  assert.equal(resumed.json.usage.total, 120);
  assert.equal(runTandem(["contact", "--kind", "sparring", "--prompt-file", prompt], { cwd: dir }).json.error, "bad_kind");
});

test("a failed contact still consumes its id and records the failure status", () => {
  const { dir, prompt } = prepared("failed");
  const failed = runTandem(["contact", "--kind", "checkpoint", "--prompt-file", prompt], { cwd: dir, env: { FAKE_CODEX_MODE: "fail" } });
  assert.equal(failed.json.error, "codex_failed");
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8"));
  assert.equal(state.contacts, 1);
  assert.equal(state.lastContact.id, "C1");
  assert.equal(state.lastContact.status, "codex_failed");
  const next = runTandem(["contact", "--kind", "checkpoint", "--prompt-file", prompt], { cwd: dir });
  assert.equal(next.json.contactId, "C2");
});

test("the schema retry re-checks the budget before the second model call", () => {
  const { dir, prompt, logFile } = prepared("retrybudget");
  // First attempt passes the guard; the fake returns invalid JSON; the retry must consult the guard again.
  const result = runTandem(["contact", "--kind", "checkpoint", "--prompt-file", prompt], { cwd: dir, env: { FAKE_CODEX_MODE: "invalid_json", FAKE_CODEX_LOG: logFile } });
  assert.equal(result.json.error, "invalid_output");
  const appServerCalls = readLog(logFile).filter((c) => c.argv[0] === "app-server").length;
  assert.equal(appServerCalls, 2);
});
