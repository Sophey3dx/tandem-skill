import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, parseReplyFile, schemaPath, semanticErrors, validate } from "../scripts/lib/schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OK_VERDICT = { verdict: "OK", checked: ["src/a.js"], points: [], residualRisk: "gering" };

test("schemaPath rejects unknown names", () => {
  assert.throws(() => schemaPath("nope"), (e) => e.code === "bad_schema");
  assert.equal(path.isAbsolute(schemaPath("verdict")), true);
});

test("validate accepts a valid verdict with nullable fields", () => {
  const schema = loadSchema("verdict");
  const value = { ...OK_VERDICT, points: [{ id: "C1-1", severity: "MINOR", text: "x", file: null, line: null }] };
  assert.deepEqual(validate(schema, value), []);
});

test("validate reports enum, missing and unexpected properties", () => {
  const schema = loadSchema("verdict");
  const errors = validate(schema, { verdict: "MAYBE", checked: [], points: [{ id: "a", severity: "HUGE", text: "t", file: "f" }], residualRisk: "r", extra: 1 });
  assert.ok(errors.some((e) => e.includes("$.verdict")));
  assert.ok(errors.some((e) => e.includes("$.points[0].line: missing")));
  assert.ok(errors.some((e) => e.includes("$.points[0].severity")));
  assert.ok(errors.some((e) => e.includes("$.extra: unexpected")));
});

test("validate accepts a plan verdict and rejects wrong types", () => {
  const schema = loadSchema("plan-verdict");
  const good = { verdict: "APPROVE", checked: ["plan.md"], criteria: { blockersOpen: 0, sourcesRead: true, testStrategyFeasible: true, residualRisk: "r" }, points: [] };
  assert.deepEqual(validate(schema, good), []);
  const bad = { ...good, criteria: { ...good.criteria, blockersOpen: "0" } };
  assert.ok(validate(schema, bad).some((e) => e.includes("$.criteria.blockersOpen")));
});

test("parseReplyFile handles missing file, invalid JSON and valid reply", () => {
  const tmp = path.join(HERE, ".tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const missing = path.join(tmp, "missing.json");
  assert.equal(parseReplyFile(missing, "verdict").parsed, null);
  const badFile = path.join(tmp, "bad.json");
  fs.writeFileSync(badFile, "not json", "utf8");
  const bad = parseReplyFile(badFile, "verdict");
  assert.equal(bad.parsed, null);
  assert.ok(bad.errors[0].includes("not JSON"));
  const goodFile = path.join(tmp, "good.json");
  fs.writeFileSync(goodFile, JSON.stringify(OK_VERDICT), "utf8");
  assert.deepEqual(parseReplyFile(goodFile, "verdict").parsed, OK_VERDICT);
});

test("semanticErrors catches verdict/severity contradictions, empty risk and foreign ids", () => {
  const major = { id: "C3-1", severity: "MAJOR", text: "x", file: null, line: null };
  const blocker = { ...major, id: "C3-2", severity: "BLOCKER" };
  assert.deepEqual(semanticErrors("verdict", { verdict: "CONCERN", checked: [], points: [major], residualRisk: "r" }, { idPrefix: "C3" }), []);
  assert.ok(semanticErrors("verdict", { verdict: "OK", checked: [], points: [major], residualRisk: "r" }).some((e) => e.includes("MAJOR points contradict")));
  assert.ok(semanticErrors("verdict", { verdict: "CONCERN", checked: [], points: [blocker], residualRisk: "r" }).some((e) => e.includes("require verdict BLOCK")));
  assert.ok(semanticErrors("verdict", { verdict: "BLOCK", checked: [], points: [major], residualRisk: "r" }).some((e) => e.includes("requires a BLOCKER")));
  assert.ok(semanticErrors("verdict", { verdict: "CONCERN", checked: [], points: [], residualRisk: "r" }).some((e) => e.includes("at least one point")));
  assert.ok(semanticErrors("verdict", { verdict: "OK", checked: [], points: [], residualRisk: "  " }).some((e) => e.includes("residualRisk")));
  assert.ok(semanticErrors("verdict", { verdict: "CONCERN", checked: [], points: [major], residualRisk: "r" }, { idPrefix: "R" }).some((e) => e.includes("must match R-<n>")));
  const plan = { verdict: "APPROVE", checked: [], criteria: { blockersOpen: 0, sourcesRead: true, testStrategyFeasible: true, residualRisk: "r" }, points: [] };
  assert.deepEqual(semanticErrors("plan-verdict", plan, { idPrefix: "P1" }), []);
  assert.ok(semanticErrors("plan-verdict", { ...plan, points: [{ ...major, id: "P1-1", category: "scope", section: null, newEvidence: null }] }).some((e) => e.includes("APPROVE contradicts")));
  assert.ok(semanticErrors("plan-verdict", { ...plan, criteria: { ...plan.criteria, blockersOpen: 2 } }).some((e) => e.includes("APPROVE contradicts")));
  assert.ok(semanticErrors("plan-verdict", { ...plan, verdict: "REVISE" }).some((e) => e.includes("REVISE requires")));
  const minor = { id: "P1-1", severity: "MINOR", category: "scope", text: "x", section: null, newEvidence: null };
  assert.ok(semanticErrors("plan-verdict", { ...plan, verdict: "REVISE", points: [minor] }).some((e) => e.includes("MINOR never blocks")));
  assert.deepEqual(semanticErrors("plan-verdict", { ...plan, verdict: "REVISE", criteria: { ...plan.criteria, blockersOpen: 1 }, points: [minor] }), []);
  assert.ok(semanticErrors("plan-verdict", { ...plan, criteria: { ...plan.criteria, residualRisk: "" } }).some((e) => e.includes("residualRisk")));
});

test("parseReplyFile applies semantic checks after the structural ones", () => {
  const tmp = path.join(HERE, ".tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, "semantic.json");
  fs.writeFileSync(file, JSON.stringify({ ...OK_VERDICT, points: [{ id: "X-1", severity: "MAJOR", text: "t", file: null, line: null }] }), "utf8");
  const result = parseReplyFile(file, "verdict", { idPrefix: "C7" });
  assert.equal(result.parsed, null);
  assert.ok(result.errors.some((e) => e.includes("must match C7-<n>")));
  assert.ok(result.errors.some((e) => e.includes("MAJOR points contradict verdict OK")));
});

test("parseReplyFile enforces the point caps (5 for verdict, 8 for plan-verdict)", () => {
  const tmp = path.join(HERE, ".tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const point = (i) => ({ id: `C1-${i}`, severity: "MINOR", text: "x", file: null, line: null });
  const tooMany = path.join(tmp, "toomany.json");
  fs.writeFileSync(tooMany, JSON.stringify({ ...OK_VERDICT, points: [1, 2, 3, 4, 5, 6].map(point) }), "utf8");
  const result = parseReplyFile(tooMany, "verdict");
  assert.equal(result.parsed, null);
  assert.ok(result.errors.some((e) => e.includes("$.points: more than 5")));
});
