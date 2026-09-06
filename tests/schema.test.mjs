import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, parseReplyFile, schemaPath, validate } from "../scripts/lib/schema.mjs";

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
