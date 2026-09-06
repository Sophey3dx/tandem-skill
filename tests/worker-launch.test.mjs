import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseJsonl } from "../scripts/lib/codex.mjs";
import { makeProject } from "./helpers.mjs";

const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lib", "worker-launch.mjs");

function launch(logFile, cmd, args, { stdinText = "" } = {}) {
  const stdinFile = path.join(path.dirname(logFile), "stdin.txt");
  fs.writeFileSync(stdinFile, stdinText, "utf8");
  const inFd = fs.openSync(stdinFile, "r");
  const outFd = fs.openSync(logFile, "a");
  try {
    return spawnSync(process.execPath, [LAUNCHER, logFile, cmd, ...args], { stdio: [inFd, outFd, outFd], encoding: "utf8", timeout: 20000 });
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
}

test("the launcher passes stdio through, writes launched.json and appends the child's exit code to the log", () => {
  const dir = makeProject("launch");
  const logFile = path.join(dir, "log.txt");
  const script = "process.stdout.write(require('fs').readFileSync(0,'utf8').toUpperCase() + '\\n'); process.stderr.write('err-line\\n'); process.exit(5)";
  const result = launch(logFile, process.execPath, ["-e", script], { stdinText: "brief text" });
  assert.equal(result.status, 5, "the launcher exits with the child's code");
  const text = fs.readFileSync(logFile, "utf8");
  assert.match(text, /^BRIEF TEXT\r?\n/, "stdin reached the child, stdout reached the log");
  assert.match(text, /err-line/, "stderr reached the log");
  const exit = parseJsonl(text).find((e) => e.type === "tandem.exit");
  assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 5, signal: null });
  assert.ok(Date.parse(exit.at) > 0);
  const marker = JSON.parse(fs.readFileSync(path.join(dir, "launched.json"), "utf8"));
  assert.equal(marker.pid, result.pid, "launched.json names the launcher itself");
  assert.ok(Number.isInteger(marker.childPid), "and the child it started");
});

test("the launcher reports a command that cannot be started (no shell, no throw) as exit 127", () => {
  const dir = makeProject("launch-missing");
  const logFile = path.join(dir, "log.txt");
  const result = launch(logFile, path.join(dir, "missing-codex.exe"), ["exec"]);
  assert.equal(result.status, 127);
  const exit = parseJsonl(fs.readFileSync(logFile, "utf8")).find((e) => e.type === "tandem.exit");
  assert.equal(exit.code, 127);
  assert.match(exit.error, /ENOENT/);
  assert.ok(fs.existsSync(path.join(dir, "launched.json")), "the marker is written before the spawn attempt");
});

test("the launcher refuses to run without a log file and a command", () => {
  const result = spawnSync(process.execPath, [LAUNCHER], { encoding: "utf8" });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage/);
});
