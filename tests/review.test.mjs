import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeProject, readLog, runTandem, startProject } from "./helpers.mjs";

test("review requires a git repo", () => {
  const dir = makeProject("review-nogit");
  startProject(dir);
  assert.equal(runTandem(["review"], { cwd: dir }).json.error, "not_git");
});

test("review runs codex exec review with schema and default --uncommitted", () => {
  const dir = makeProject("review");
  fs.mkdirSync(path.join(dir, ".git"));
  startProject(dir);
  const logFile = path.join(dir, "fake.log");
  const { json } = runTandem(["review", "--title", "feature x"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile, FAKE_VERDICT: "CONCERN" } });
  assert.equal(json.ok, true);
  assert.equal(json.kind, "review");
  assert.equal(json.verdict.verdict, "CONCERN");
  assert.equal(json.verdict.points[0].severity, "MAJOR");
  const call = readLog(logFile).find((c) => c.argv[1] === "review");
  assert.deepEqual(call.argv.slice(0, 3), ["exec", "review", "--uncommitted"]);
  assert.ok(call.argv.includes("--output-schema"));
  assert.ok(call.argv.includes("--title"));
  assert.equal(call.argv.at(-1) === "-", false);
  const base = runTandem(["review", "--base", "main"], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(base.json.target, "--base main");
});
