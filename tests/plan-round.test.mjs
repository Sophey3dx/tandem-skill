import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeProject, readLog, runTandem, startProject, writeFile } from "./helpers.mjs";

function prepared(name) {
  const dir = makeProject(name);
  const logFile = path.join(dir, "fake.log");
  startProject(dir);
  const plan = writeFile(dir, "plan.md", "# Plan\n\n## Task 1\nDo X.");
  const matrix = writeFile(dir, "matrix.md", "- P1-1 → accepted: fixed in Task 1");
  return { dir, logFile, plan, matrix };
}

test("round 1 uses high effort, full plan and reports consensus on APPROVE", () => {
  const { dir, logFile, plan } = prepared("plan1");
  const { json } = runTandem(["plan-round", "--round", "1", "--plan-file", plan], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(json.ok, true);
  assert.equal(json.round, 1);
  assert.equal(json.consensus, true);
  assert.equal(json.roundsLeft, 2);
  assert.equal(json.planHash.length, 12);
  const call = readLog(logFile).find((c) => c.argv[1] === "resume");
  assert.ok(call.argv.includes("model_reasoning_effort=high"));
  assert.ok(call.stdin.includes("Tandem-Planrunde 1 von 3"));
  assert.ok(call.stdin.includes("Do X."));
  assert.ok(!call.stdin.includes("Antwort auf deine Einwände"));
  assert.ok(fs.existsSync(path.join(dir, ".tandem", "plans", "plan-r1.md")));
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8"));
  assert.equal(state.plan.round, 1);
  assert.equal(state.plan.verdicts[0].verdict, "APPROVE");
});

test("REVISE yields no consensus; round 2 needs the matrix and medium effort", () => {
  const { dir, logFile, plan, matrix } = prepared("plan2");
  const first = runTandem(["plan-round", "--round", "1", "--plan-file", plan], { cwd: dir, env: { FAKE_PLAN_VERDICT: "REVISE" } });
  assert.equal(first.json.consensus, false);
  assert.equal(first.json.verdict.points[0].id, "P1-1");
  assert.equal(runTandem(["plan-round", "--round", "2", "--plan-file", plan], { cwd: dir }).json.error, "matrix_required");
  const second = runTandem(["plan-round", "--round", "2", "--plan-file", plan, "--matrix-file", matrix], { cwd: dir, env: { FAKE_CODEX_LOG: logFile } });
  assert.equal(second.json.consensus, true);
  const call = readLog(logFile).find((c) => c.argv[1] === "resume");
  assert.ok(call.argv.includes("model_reasoning_effort=medium"));
  assert.ok(call.stdin.includes("Einwände aus Runde 1"));
  assert.ok(call.stdin.includes("P1-1 → accepted"));
});

test("round order is enforced and round 4 is rejected", () => {
  const { dir, plan, matrix } = prepared("plan3");
  assert.equal(runTandem(["plan-round", "--round", "2", "--plan-file", plan, "--matrix-file", matrix], { cwd: dir }).json.error, "round_order");
  assert.equal(runTandem(["plan-round", "--round", "4", "--plan-file", plan, "--matrix-file", matrix], { cwd: dir }).json.error, "bad_round");
});

test("a plan written directly to .tandem/plans/plan-r1.md is accepted (no self-copy)", () => {
  const { dir } = prepared("plan-self");
  const inPlace = writeFile(dir, path.join(".tandem", "plans", "plan-r1.md"), "# Plan in place");
  const { json } = runTandem(["plan-round", "--round", "1", "--plan-file", inPlace], { cwd: dir });
  assert.equal(json.ok, true);
  assert.equal(fs.readFileSync(inPlace, "utf8"), "# Plan in place");
});

test("APPROVE without a named residual risk is not consensus; a failed round keeps the previous plan state", () => {
  const { dir, plan } = prepared("plan-risk");
  const noRisk = runTandem(["plan-round", "--round", "1", "--plan-file", plan], { cwd: dir, env: { FAKE_PLAN_RISK: "  " } });
  assert.equal(noRisk.json.verdict.verdict, "APPROVE");
  assert.equal(noRisk.json.consensus, false);
  const before = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8")).plan;
  assert.equal(before.round, 1);
  const failed = runTandem(["plan-round", "--round", "1", "--plan-file", plan], { cwd: dir, env: { FAKE_CODEX_MODE: "fail" } });
  assert.equal(failed.json.error, "codex_failed");
  const after = JSON.parse(fs.readFileSync(path.join(dir, ".tandem", "state.json"), "utf8")).plan;
  assert.deepEqual(after, before);
});
