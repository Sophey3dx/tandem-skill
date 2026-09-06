import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../scripts/lib/args.mjs";

test("parseArgs: positionals, values, flags, equals form", () => {
  const { positionals, options } = parseArgs(
    ["begleiter", "--kind", "checkpoint", "--human", "--effort=low", "--round", "2"],
    { flags: ["human"] }
  );
  assert.deepEqual(positionals, ["begleiter"]);
  assert.equal(options.kind, "checkpoint");
  assert.equal(options.human, true);
  assert.equal(options.effort, "low");
  assert.equal(options.round, "2");
});

test("parseArgs: trailing option without value becomes true", () => {
  const { options } = parseArgs(["--uncommitted"], { flags: [] });
  assert.equal(options.uncommitted, true);
});

test("parseArgs: option followed by another option becomes true", () => {
  const { options } = parseArgs(["--force", "--kind", "final"], { flags: [] });
  assert.equal(options.force, true);
  assert.equal(options.kind, "final");
});
