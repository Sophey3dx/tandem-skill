import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonical, ensureGitignoreEntry, ensureLayout, isUnder, isUnderTemp, requireAbsolute, stamp, tandemLayout
} from "../scripts/lib/paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = path.join(HERE, ".tmp");

function project() {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, "paths-"));
}

test("isUnder and canonical are case-insensitive on win32", () => {
  const parent = project();
  const child = path.join(parent, "Sub", "file.txt");
  assert.equal(isUnder(child, parent), true);
  assert.equal(isUnder(parent, child), false);
  assert.equal(isUnder(parent, parent), true);
  if (process.platform === "win32") assert.equal(canonical(parent.toUpperCase()), canonical(parent));
});

test("isUnderTemp detects the OS temp dir and not the test folder", () => {
  assert.equal(isUnderTemp(path.join(os.tmpdir(), "x")), true);
  assert.equal(isUnderTemp(project()), false);
});

test("tandemLayout + ensureLayout create the folders", () => {
  const dir = project();
  const layout = ensureLayout(dir);
  assert.equal(layout.root, path.join(dir, ".tandem"));
  for (const d of [layout.prompts, layout.replies, layout.plans, layout.workers, layout.design]) {
    assert.equal(fs.existsSync(d), true, d);
  }
  assert.equal(tandemLayout(dir).stateFile, path.join(dir, ".tandem", "state.json"));
});

test("requireAbsolute rejects relative paths", () => {
  assert.throws(() => requireAbsolute("relative/x.md", "--prompt-file"), (e) => e.code === "bad_path");
  assert.equal(path.isAbsolute(requireAbsolute(project(), "--project")), true);
});

test("stamp pads to four digits", () => {
  assert.equal(stamp(7), "0007");
  assert.equal(stamp(1234), "1234");
});

test("ensureGitignoreEntry only acts in git repos and is idempotent", () => {
  const dir = project();
  assert.equal(ensureGitignoreEntry(dir, ".tandem/"), false);
  fs.mkdirSync(path.join(dir, ".git"));
  assert.equal(ensureGitignoreEntry(dir, ".tandem/"), true);
  assert.equal(ensureGitignoreEntry(dir, ".tandem/"), false);
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\.tandem\/$/m);
});
