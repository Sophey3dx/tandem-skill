import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initGitRepo, makeProject, readLog, runTandem, startProject } from "./helpers.mjs";

test("review requires a git repo", () => {
  const dir = makeProject("review-nogit");
  startProject(dir);
  assert.equal(runTandem(["review"], { cwd: dir }).json.error, "not_git");
});

test("review runs a fresh codex exec with the review contract and the verdict schema", () => {
  const dir = initGitRepo(makeProject("review"));
  startProject(dir);
  const logFile = path.join(dir, "fake.log");
  const { json } = runTandem(["review", "--title", "feature x"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile, FAKE_VERDICT: "CONCERN", FAKE_THREAD_ID: "review-thread" } });
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.equal(json.kind, "review");
  assert.equal(json.target, "--uncommitted");
  assert.equal(json.attempts, 1);
  assert.equal(json.reviewThreadId, "review-thread");
  assert.match(json.resolvedRef, /^[0-9a-f]{40}$/);
  assert.equal(json.verdict.verdict, "CONCERN");
  assert.equal(json.verdict.points[0].severity, "MAJOR");
  assert.equal(json.verdict.points[0].id, "R-1");
  const call = readLog(logFile).find((c) => c.argv[0] === "exec");
  assert.ok(!call.argv.includes("review"), "must not use `codex exec review` (ignores --output-schema)");
  assert.ok(call.argv.includes("--output-schema"));
  assert.ok(call.argv.includes("read-only"));
  assert.equal(call.argv.at(-1), "-");
  assert.ok(call.stdin.includes("Tandem-Abschluss-Review: uncommittete Änderungen"));
  assert.ok(call.stdin.includes("feature x"));
  assert.ok(call.stdin.includes("git diff"));
  assert.ok(fs.existsSync(path.join(dir, ".tandem", "prompts", "0001-review.md")));
  const base = runTandem(["review", "--base", "main"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(base.json.target, "--base main");
  const baseCall = readLog(logFile).filter((c) => c.argv[0] === "exec" && c.argv[1] !== "resume").at(-1);
  assert.ok(baseCall.stdin.includes("git diff main...HEAD"));
});

test("combined target options are rejected", () => {
  const dir = initGitRepo(makeProject("review-target"));
  startProject(dir);
  const logFile = path.join(dir, "fake.log");
  assert.equal(runTandem(["review", "--base", "main", "--uncommitted"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } }).json.error, "bad_target");
  assert.equal(runTandem(["review", "--base", "main", "--commit", "HEAD"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } }).json.error, "bad_target");
  assert.equal(readLog(logFile).filter((c) => c.argv[0] === "exec").length, 0);
});

test("an unresolvable ref is rejected before any model call", () => {
  const dir = initGitRepo(makeProject("review-badref"));
  startProject(dir);
  const logFile = path.join(dir, "fake.log");
  const bad = runTandem(["review", "--base", "no-such-branch"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(bad.json.error, "bad_ref");
  const badCommit = runTandem(["review", "--commit", "deadbeef"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(badCommit.json.error, "bad_ref");
  assert.equal(readLog(logFile).filter((c) => c.argv[0] === "exec").length, 0);
  // A real repository without any commit (a bare `.git` folder would make git walk up into the parent repo).
  const empty = makeProject("review-emptyrepo");
  spawnSync("git", ["-C", empty, "init", "-q", "-b", "main"], { encoding: "utf8" });
  startProject(empty);
  assert.equal(runTandem(["review"], { cwd: empty }).json.error, "bad_ref", "no commit to diff against");
});

test("a schema-invalid review answer is retried once by resuming the review thread", () => {
  const dir = initGitRepo(makeProject("review-retry"));
  startProject(dir);
  const logFile = path.join(dir, "fake.log");
  const { json } = runTandem(["review"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile, FAKE_CODEX_MODE: "invalid_json", FAKE_THREAD_ID: "review-thread" } });
  assert.equal(json.error, "invalid_output");
  const execCalls = readLog(logFile).filter((c) => c.argv[0] === "exec");
  assert.equal(execCalls.length, 2);
  assert.equal(execCalls[1].argv[1], "resume");
  assert.equal(execCalls[1].argv[2], "review-thread");
  assert.ok(execCalls[1].stdin.includes("nicht schema-konform"));
  assert.equal(readLog(logFile).filter((c) => c.argv[0] === "app-server").length, 2, "budget checked before each attempt");
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8"));
  assert.equal(state.lastContact.status, "invalid_output");
  assert.equal(state.usage.byKind.review.runs, 2);
});
