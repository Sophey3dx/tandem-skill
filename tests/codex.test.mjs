import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  KILL_GRACE_MS, buildResumeArgs, buildStartArgs, classifyFailure, failureToError, killTree, minutes, normalizeEffort,
  parseJsonl, resolveCodex, runCodex, threadIdFromEvents
} from "../scripts/lib/codex.mjs";
import { FAKE, makeProject, readLog, writeFile } from "./helpers.mjs";

const env = (extra = {}) => ({ ...process.env, TANDEM_CODEX_BIN: FAKE, ...extra });

test("resolveCodex uses TANDEM_CODEX_BIN and runs .mjs through node", () => {
  const resolved = resolveCodex(env());
  assert.equal(resolved.cmd, process.execPath);
  assert.deepEqual(resolved.prefix, [FAKE]);
  assert.deepEqual(resolveCodex({ TANDEM_CODEX_BIN: "C:\\x\\codex.exe" }), { cmd: "C:\\x\\codex.exe", prefix: [] });
});

test("normalizeEffort and minutes validate input", () => {
  assert.equal(normalizeEffort("HIGH"), "high");
  assert.throws(() => normalizeEffort("turbo"), (e) => e.code === "bad_effort");
  assert.equal(minutes("0.5"), 30000);
  assert.throws(() => minutes("-1"), (e) => e.code === "bad_deadline");
});

test("runCodex pipes the prompt file via stdin and parses JSONL events", async () => {
  const dir = makeProject("codex");
  const logFile = path.join(dir, "fake.log");
  const prompt = writeFile(dir, "prompt.md", "Hallo Codex");
  const outFile = path.join(dir, "reply.md");
  const result = await runCodex({
    args: buildStartArgs({ project: dir, effort: "low", outFile }),
    promptFile: prompt, cwd: dir, timeoutMs: 20000,
    env: env({ FAKE_CODEX_LOG: logFile, FAKE_THREAD_ID: "thread-abc" })
  });
  assert.equal(result.status, 0);
  assert.equal(result.failure, null);
  assert.equal(threadIdFromEvents(result.events), "thread-abc");
  assert.equal(fs.readFileSync(outFile, "utf8"), "FAKE OK");
  const calls = readLog(logFile);
  assert.equal(calls[0].stdin, "Hallo Codex");
  assert.equal(calls[0].argv[0], "exec");
  assert.ok(calls[0].argv.includes("--skip-git-repo-check"));
});

test("runCodex kills a hanging process after the deadline", async () => {
  const dir = makeProject("hang");
  const prompt = writeFile(dir, "prompt.md", "x");
  const started = Date.now();
  const result = await runCodex({
    args: ["exec", "--json", "-"], promptFile: prompt, cwd: dir, timeoutMs: 2000,
    env: env({ FAKE_CODEX_MODE: "hang" })
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.failure, "timeout");
  assert.equal(result.killed, true);
  assert.ok(Date.now() - started < 15000);
});

test("runCodex still resolves when the kill fails (grace period), caller cleans up", async () => {
  const dir = makeProject("nokill");
  const prompt = writeFile(dir, "prompt.md", "x");
  const started = Date.now();
  const result = await runCodex({
    args: ["exec", "--json", "-"], promptFile: prompt, cwd: dir, timeoutMs: 1000,
    env: env({ FAKE_CODEX_MODE: "hang", TANDEM_TEST_NO_KILL: "1" })
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.killed, false);
  assert.equal(result.failure, "timeout");
  assert.ok(Date.now() - started < 1000 + KILL_GRACE_MS + 3000);
  killTree(result.pid);
});

test("classifyFailure maps known error texts", () => {
  assert.equal(classifyFailure({ status: 0, timedOut: false }), null);
  assert.equal(classifyFailure({ status: 1, timedOut: false, stderr: "Session not found for thread_id: x" }), "thread_lost");
  assert.equal(classifyFailure({ status: 1, timedOut: false, stderr: "You've hit your usage limit" }), "quota");
  assert.equal(classifyFailure({ status: 1, timedOut: false, stderr: "Not logged in. Run `codex login`." }), "auth");
  assert.equal(classifyFailure({ status: 2, timedOut: false, stderr: "boom" }), "codex_failed");
  assert.equal(failureToError({ failure: "quota", stderr: "limit", durationMs: 1, status: 1 }, "contact").code, "quota");
});

test("buildResumeArgs uses read-only sandbox, schema and absolute output", () => {
  const args = buildResumeArgs({ threadId: "t1", effort: "medium", schemaPath: "C:\\s.json", outFile: "C:\\o.json" });
  assert.deepEqual(args, [
    "exec", "resume", "t1", "--skip-git-repo-check", "--json",
    "-c", "sandbox_mode=read-only", "-c", "model_reasoning_effort=medium",
    "--output-schema", "C:\\s.json", "-o", "C:\\o.json", "-"
  ]);
  assert.deepEqual(parseJsonl('{"type":"a"}\nnoise\n{"type":"b"}\n'), [{ type: "a" }, { type: "b" }]);
});
