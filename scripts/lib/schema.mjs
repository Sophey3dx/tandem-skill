import fs from "node:fs";
import path from "node:path";
import { TandemError } from "./output.mjs";
import { SCHEMAS_DIR } from "./paths.mjs";

export const SCHEMA_NAMES = ["verdict", "plan-verdict", "worker-result", "sparring"];

export function schemaPath(name) {
  if (!SCHEMA_NAMES.includes(name)) {
    throw new TandemError("bad_schema", `Unknown schema "${name}".`, `Use one of: ${SCHEMA_NAMES.join(", ")}`);
  }
  return path.join(SCHEMAS_DIR, `${name}.schema.json`);
}

export function loadSchema(name) {
  return JSON.parse(fs.readFileSync(schemaPath(name), "utf8"));
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  const allowed = Array.isArray(expected) ? expected : [expected];
  return allowed.some((t) => t === actual || (t === "number" && actual === "integer"));
}

export function validate(schema, value, at = "$") {
  const errors = [];
  if (schema.type && !matchesType(schema.type, value)) {
    errors.push(`${at}: expected ${JSON.stringify(schema.type)}, got ${typeOf(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: must be one of ${schema.enum.join("|")}`);
  }
  if (typeOf(value) === "object" && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: missing`);
    }
    for (const [key, sub] of Object.entries(value)) {
      if (schema.properties[key]) errors.push(...validate(schema.properties[key], sub, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unexpected property`);
    }
  }
  if (typeOf(value) === "array" && schema.items) {
    value.forEach((item, index) => errors.push(...validate(schema.items, item, `${at}[${index}]`)));
  }
  return errors;
}

// Caps are enforced here, not in the schema files: OpenAI strict mode does not reliably accept maxItems.
export const POINT_CAPS = { verdict: 5, "plan-verdict": 8 };

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Consistency rules the schema alone cannot express: verdict vs. point severities, non-empty residual risk,
// point ids in the contract's format, and from plan round 2 on evidence for every blocking point.
// A violation counts as an invalid answer and triggers the one retry.
export function semanticErrors(schemaName, value, { idPrefix, round } = {}) {
  const errors = [];
  const points = Array.isArray(value?.points) ? value.points : [];
  const severities = new Set(points.map((p) => p?.severity));
  const worst = severities.has("BLOCKER") ? "BLOCKER" : severities.has("MAJOR") ? "MAJOR" : null;
  if (idPrefix) {
    const pattern = new RegExp(`^${escapeRegExp(idPrefix)}-\\d+$`);
    points.forEach((p, index) => {
      if (!pattern.test(String(p?.id ?? ""))) errors.push(`$.points[${index}].id: must match ${idPrefix}-<n>`);
    });
  }
  if (schemaName === "verdict") {
    if (!String(value?.residualRisk ?? "").trim()) errors.push("$.residualRisk: must not be empty");
    if (worst === "BLOCKER" && value?.verdict !== "BLOCK") errors.push("$.verdict: BLOCKER points require verdict BLOCK");
    if (worst === "MAJOR" && value?.verdict === "OK") errors.push("$.verdict: MAJOR points contradict verdict OK");
    if (value?.verdict === "BLOCK" && worst !== "BLOCKER") errors.push("$.verdict: BLOCK requires a BLOCKER point");
    if (value?.verdict === "CONCERN" && points.length === 0) errors.push("$.points: CONCERN requires at least one point");
  }
  if (schemaName === "plan-verdict") {
    if (!String(value?.criteria?.residualRisk ?? "").trim()) errors.push("$.criteria.residualRisk: must not be empty");
    if (value?.verdict === "APPROVE" && (worst || Number(value?.criteria?.blockersOpen) > 0)) {
      errors.push("$.verdict: APPROVE contradicts open BLOCKER/MAJOR points");
    }
    if (value?.verdict === "REVISE" && !worst && !(Number(value?.criteria?.blockersOpen) > 0)) {
      errors.push("$.verdict: REVISE requires a BLOCKER/MAJOR point or blockersOpen > 0 (MINOR never blocks)");
    }
    if (Number(round) >= 2) {
      points.forEach((p, index) => {
        if ((p?.severity === "BLOCKER" || p?.severity === "MAJOR") && !String(p?.newEvidence ?? "").trim()) {
          errors.push(`$.points[${index}].newEvidence: required for BLOCKER/MAJOR points from round 2 on (new evidence or a reference to the earlier point)`);
        }
      });
    }
  }
  if (schemaName === "sparring") {
    if (!String(value?.position ?? "").trim()) errors.push("$.position: must not be empty");
    if (!String(value?.recommendation ?? "").trim()) errors.push("$.recommendation: must not be empty");
    for (const key of ["reasons", "risks"]) {
      if (Array.isArray(value?.[key]) && value[key].length > 8) errors.push(`$.${key}: more than 8 items`);
    }
  }
  if (schemaName === "worker-result") {
    const remaining = Array.isArray(value?.remaining) ? value.remaining : [];
    const blockers = Array.isArray(value?.blockers) ? value.blockers : [];
    if (value?.status === "DONE" && (remaining.length > 0 || blockers.length > 0)) errors.push("$.status: DONE contradicts remaining work or blockers");
    if (value?.status === "BLOCKED" && blockers.length === 0) errors.push("$.status: BLOCKED requires at least one blocker with evidence");
    if (value?.status === "PARTIAL" && remaining.length === 0) errors.push("$.status: PARTIAL requires remaining work");
  }
  return errors;
}

export function parseReplyFile(file, schemaName, { idPrefix, round } = {}) {
  if (!fs.existsSync(file)) return { parsed: null, errors: [`reply file missing: ${file}`], raw: null };
  const raw = fs.readFileSync(file, "utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { parsed: null, errors: [`reply is not JSON: ${error.message}`], raw };
  }
  const errors = validate(loadSchema(schemaName), value);
  const cap = POINT_CAPS[schemaName];
  if (cap && Array.isArray(value?.points) && value.points.length > cap) errors.push(`$.points: more than ${cap} items`);
  if (errors.length === 0) errors.push(...semanticErrors(schemaName, value, { idPrefix, round }));
  return { parsed: errors.length === 0 ? value : null, errors, raw };
}
