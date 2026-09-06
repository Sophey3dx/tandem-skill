#!/usr/bin/env node
// Simulates the codex CLI for tests. Env switches:
//   FAKE_CODEX_MODE      ok | hang | fail | thread_lost | quota | auth | invalid_json   (default ok)
//   FAKE_CODEX_LOG       file that receives one JSON line per invocation {argv, stdin, cwd}
//   FAKE_THREAD_ID       thread id reported in thread.started
//   FAKE_CODEX_REPLY     text written to -o when no schema is given
//   FAKE_VERDICT         OK | CONCERN | BLOCK   (verdict schema)
//   FAKE_PLAN_VERDICT    APPROVE | REVISE       (plan-verdict schema)
//   FAKE_PLAN_RISK       text for criteria.residualRisk
//   FAKE_USED_PRIMARY / FAKE_USED_SECONDARY   usedPercent for the fake app-server
//   FAKE_RATELIMIT_MODE  ok | error | silent | crash
//   FAKE_WORKER_NO_RESULT=1   worker: emit the events (incl. the final message) but never write the -o file
//   FAKE_WORKER_EXIT_CODE     worker: exit with this code after the events (default 0)
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? "ok";

function opt(name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function log(stdin) {
  if (process.env.FAKE_CODEX_LOG) {
    fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ argv, stdin, cwd: process.cwd() })}\n`);
  }
}

function fail(text, code = 1) {
  process.stderr.write(`${text}\n`);
  process.exit(code);
}

// Point ids must follow the contract's prefix (C<n>, P<round>, R). The prompt states it; parse it from stdin.
function idPrefixFrom(stdin) {
  const match = /(?:Format|IDs|`id`) ([A-Z]+\d*)-1/.exec(stdin);
  return match ? match[1] : "C1";
}

function sampleFor(schema, stdin) {
  const prefix = idPrefixFrom(stdin);
  const verdictEnum = schema.properties?.verdict?.enum ?? [];
  if (verdictEnum.includes("APPROVE")) {
    const verdict = process.env.FAKE_PLAN_VERDICT ?? "APPROVE";
    const round = Number(/Planrunde (\d) von 3/.exec(stdin)?.[1] ?? 1);
    // From round 2 on the contract demands newEvidence on blocking points; FAKE_PLAN_NO_EVIDENCE=1 omits it.
    const newEvidence = round >= 2 && process.env.FAKE_PLAN_NO_EVIDENCE !== "1" ? "wie P1-1, unverändert" : null;
    return {
      verdict,
      checked: ["plan.md"],
      criteria: { blockersOpen: verdict === "APPROVE" ? 0 : 1, sourcesRead: true, testStrategyFeasible: true, residualRisk: process.env.FAKE_PLAN_RISK ?? "gering" },
      points: verdict === "APPROVE" ? [] : [{ id: `${prefix}-1`, severity: "MAJOR", category: "correctness", text: "fake objection", section: "Task 1", newEvidence }]
    };
  }
  if (verdictEnum.includes("OK")) {
    const verdict = process.env.FAKE_VERDICT ?? "OK";
    return {
      verdict,
      checked: ["src/a.js"],
      points: verdict === "OK" ? [] : [{ id: `${prefix}-1`, severity: verdict === "BLOCK" ? "BLOCKER" : "MAJOR", text: "fake concern", file: "src/a.js", line: 3 }],
      residualRisk: "gering"
    };
  }
  if (schema.properties?.status) {
    const status = process.env.FAKE_WORKER_STATUS ?? "DONE";
    const zone = opt("-C");
    if (zone && process.env.FAKE_WORKER_WRITE === "1") fs.writeFileSync(path.join(zone, "ok.txt"), "ok", "utf8");
    return {
      status,
      touchedFiles: ["ok.txt"],
      tests: [{ cmd: "node --test", exitCode: 0 }],
      remaining: status === "PARTIAL" ? ["rest of the task"] : [],
      blockers: status === "BLOCKED" ? [{ text: "fake blocker", evidence: "ok.txt:1" }] : [],
      notes: "fake worker"
    };
  }
  return {
    position: process.env.FAKE_SPARRING_EMPTY === "1" ? "" : "fake position",
    reasons: ["r1"],
    checked: ["src/a.js"],
    risks: ["risk"],
    recommendation: "do it"
  };
}

// FAKE_USED_PRIMARY_SEQUENCE="18,97" lets consecutive rate-limit queries (counted via FAKE_CODEX_LOG) return
// different values, e.g. to refuse the budget only before a retry.
function primaryUsed() {
  const sequence = process.env.FAKE_USED_PRIMARY_SEQUENCE?.split(",").map((v) => Number(v.trim()));
  if (sequence?.length && process.env.FAKE_CODEX_LOG && fs.existsSync(process.env.FAKE_CODEX_LOG)) {
    const calls = fs.readFileSync(process.env.FAKE_CODEX_LOG, "utf8").split(/\r?\n/).filter((l) => l.includes('"argv":["app-server"')).length;
    return sequence[Math.min(Math.max(calls - 1, 0), sequence.length - 1)];
  }
  return Number(process.env.FAKE_USED_PRIMARY ?? 18);
}

function appServer() {
  const used = { primary: primaryUsed(), secondary: Number(process.env.FAKE_USED_SECONDARY ?? 6) };
  // FAKE_RATELIMIT_MODE: ok (default) | error (JSON-RPC error) | silent (never answers) | crash (exit before answering)
  const limitMode = process.env.FAKE_RATELIMIT_MODE ?? "ok";
  if (limitMode === "crash") process.exit(3);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.method === "initialize") {
        process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "fake-app-server" } })}\n`);
      } else if (message.method === "account/rateLimits/read" && limitMode === "silent") {
        // never answer; the runner must time out and fail open
      } else if (message.method === "account/rateLimits/read" && limitMode === "error") {
        process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: "fake rate limit error" } })}\n`);
      } else if (message.method === "account/rateLimits/read") {
        const result = {
          rateLimits: {
            primary: { usedPercent: used.primary, windowDurationMins: 300, resetsAt: 1788671480 },
            secondary: { usedPercent: used.secondary, windowDurationMins: 10080, resetsAt: 1789145311 },
            planType: "plus",
            rateLimitReachedType: null
          }
        };
        process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

function exec() {
  const wantsStdin = argv[argv.length - 1] === "-";
  let stdin = "";
  if (wantsStdin) {
    try {
      stdin = fs.readFileSync(0, "utf8");
    } catch {
      stdin = "";
    }
  }
  log(stdin);
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "thread_lost") fail(`Session not found for thread_id: ${argv[2] ?? "?"}`);
  if (mode === "quota") fail("You've hit your usage limit. Try again later.");
  if (mode === "auth") fail("Not logged in. Run `codex login`.");
  if (mode === "fail") fail("boom: unexpected fake failure", 2);

  const json = argv.includes("--json");
  const out = opt("-o");
  const schemaFile = opt("--output-schema");
  const threadId = process.env.FAKE_THREAD_ID ?? `fake-thread-${Math.random().toString(16).slice(2, 10)}`;
  const emit = (event) => {
    if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  let text;
  let isWorker = false;
  if (schemaFile) {
    const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
    isWorker = Boolean(schema.properties?.status);
    let invalid = mode === "invalid_json";
    if (isWorker && process.env.FAKE_WORKER_INVALID === "1") invalid = true;
    if (isWorker && process.env.FAKE_WORKER_INVALID_ONCE && !fs.existsSync(process.env.FAKE_WORKER_INVALID_ONCE)) {
      fs.writeFileSync(process.env.FAKE_WORKER_INVALID_ONCE, "seen", "utf8");
      invalid = true;
    }
    text = JSON.stringify(invalid ? { verdict: "MAYBE", status: "MAYBE" } : sampleFor(schema, stdin));
  } else {
    text = process.env.FAKE_CODEX_REPLY ?? "FAKE OK";
  }
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
  // Like codex, the -o file is written after the final message; FAKE_WORKER_NO_RESULT simulates a codex that
  // dies during shutdown and never gets to it.
  if (out && !(isWorker && process.env.FAKE_WORKER_NO_RESULT === "1")) fs.writeFileSync(out, text, "utf8");
  emit({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 } });
  process.stderr.write("tokens used\n1.234\n");
  const exitCode = isWorker && process.env.FAKE_WORKER_EXIT_CODE ? Number(process.env.FAKE_WORKER_EXIT_CODE) : 0;
  const linger = Number(process.env.FAKE_WORKER_LINGER_MS ?? 0);
  if (linger > 0 && isWorker) setTimeout(() => process.exit(exitCode), linger);
  else process.exit(exitCode);
}

if (argv[0] === "--version") {
  process.stdout.write("codex-cli 9.9.9-fake\n");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  process.stdout.write("Logged in using ChatGPT (fake)\n");
  process.exit(0);
}
if (argv[0] === "app-server") {
  log("");
  appServer();
} else {
  exec();
}
