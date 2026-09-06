import test from "node:test";
import assert from "node:assert/strict";
import { render, renderTemplate } from "../scripts/lib/prompts.mjs";

test("render replaces placeholders and blanks unknown ones", () => {
  assert.equal(render("a {{X}} b {{Y}}", { X: "1" }), "a 1 b ");
});

test("templates render with their placeholders", () => {
  const onboarding = renderTemplate("onboarding", { PROJECT_SUMMARY: "Mein Projekt", EXTRA: "" });
  assert.match(onboarding, /Mein Projekt/);
  assert.doesNotMatch(onboarding, /\{\{/);
  const contact = renderTemplate("contact", { CONTACT_ID: "C3", KIND: "checkpoint", BODY: "Delta", SCHEMA: "verdict", CAP: "Max 5." });
  assert.match(contact, /Tandem-Kontakt C3 \(checkpoint\)/);
  assert.match(contact, /C3-1/);
  const round = renderTemplate("plan-round", { ROUND: "2", PLAN_HASH: "abc", PLAN: "PLAN", MATRIX_BLOCK: renderTemplate("plan-matrix", { PREVIOUS: "1", MATRIX: "P1-1 accepted" }) });
  assert.match(round, /Runde 1/);
  assert.match(round, /P2-1/);
  assert.match(renderTemplate("ledger-template", { PROJECT: "P", DATE: "2026-09-06" }), /Projekt: P/);
});
