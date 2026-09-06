# Tandem

**Persistent pair-programming between Claude Code and the OpenAI Codex CLI.**

Tandem turns Codex from a one-shot reviewer into a standing partner. One Codex thread per project keeps the whole history: the project summary, every decision, every objection and how it was resolved. Claude sends deltas instead of briefings, Codex answers in strict JSON, and a small Node runner enforces the protocol, the budget and the safety rules.

Tandem is a [Claude Code](https://claude.com/claude-code) skill. It was designed, reviewed and hardened together with Codex itself (see *Credits*).

---

## Why

Ad-hoc "ask Codex" workflows have three recurring problems:

1. **No memory.** Every call starts from zero, so every prompt has to re-explain the project.
2. **No protocol.** Reviews happen when someone remembers, in whatever format the model picks.
3. **No budget control.** A review loop can burn through a ChatGPT usage window before anyone notices.

Tandem fixes all three: a persistent thread, a contact protocol with schema-validated verdicts, and a rate-limit guard that reads the remaining quota *before* each call and refuses to spend it below a threshold.

---

## What is in this release (Plan A, the core)

| Capability | What it does |
|------------|--------------|
| **Companion mode** (*Begleiter*) | Claude implements; Codex reviews at protocol checkpoints (after a plan, after each coherent edit block, before "done"). Verdict `OK / CONCERN / BLOCK` with up to five prioritized points. |
| **Plan consensus with automode** | A plan travels between Claude and Codex for at most three rounds. Codex answers `APPROVE / REVISE`; the runner computes a hard `consensus` flag (no open BLOCKER/MAJOR, sources read, test strategy feasible, residual risk named). On consensus the plan is executed without a human stop. No consensus after round three: both positions go to the user. |
| **Two final verdicts** | The persistent thread checks goal fidelity and earlier objections; a fresh Codex thread with an explicit review contract reads the real diff and looks for bugs without conversation bias. |
| **Cost counter** | Token usage per Codex run, summed in total, per contact kind and per session. |
| **Usage guard** | Before every model call the runner asks the Codex app-server for the remaining quota (5-hour and weekly windows). Below the threshold (default 10 %) it refuses with `quota_low` and the reset time. |
| **State, lock, rotation** | Atomic state file with backup, cross-process lock, thread history, rotation to a fresh thread seeded from the ledger. |
| **Safety** | The tandem thread is always read-only. Claude applies changes; Codex only advises. Failed contacts are recorded, never silently retried. |

Planned next (see the [design spec](docs/2026-09-06-tandem-design.md)): **sparring with fork lanes**, **work split** with sandbox-enforced write zones for Codex workers, a **design gallery** (both agents build a UI variant, you compare them side by side, standalone or as a Vite entry) and a **board** that shows the Claude ↔ Codex timeline in the browser.

---

## Requirements

- **Claude Code** (desktop app or CLI) with skills enabled.
- **Codex CLI ≥ 0.153** (`npm install -g @openai/codex`), logged in via ChatGPT or an API key (`codex login`). Usage counts against your Codex limits.
- **Node.js ≥ 18.18** (tested with 22.16). No npm dependencies.
- Tested on **Windows 11** (PowerShell and Git Bash). The runner avoids every known Windows pitfall: prompts go through stdin, binaries are resolved without `cmd.exe` quoting, process trees are killed with `taskkill /T`.

---

## Installation

```bash
git clone https://github.com/Sophey3dx/tandem-skill.git ~/.claude/skills/tandem
cd ~/.claude/skills/tandem && npm test
```

Then register the trigger in your global `CLAUDE.md` (Claude Code reads it at session start):

```markdown
# tandem
- **tandem** (`~/.claude/skills/tandem/SKILL.md`) - persistent Codex partner: companion checkpoints,
  plan consensus with automode, final double verdict, cost counter and usage guard. Trigger: `/tandem`
When the user types `/tandem`, invoke the Skill tool with `skill: "tandem"` before doing anything else.
```

Check the setup from any project folder:

```bash
node ~/.claude/skills/tandem/scripts/tandem.mjs doctor
```

`ready` must be `true`, `projectInTemp` must be `false` (workspace sandboxes cannot confine anything under `%TEMP%`).

---

## How a session looks

```text
/tandem                      → doctor, start (project summary → onboarding), ledger created
… you and Claude work …
checkpoint after an edit block → Codex: OK, 2 MINOR points → Claude fixes one, defers one to the ledger
/tandem plan                 → plan round 1 (high effort): REVISE, 3 points
                             → Claude answers each point in a matrix, round 2: APPROVE, consensus → automode
… plan executes, one checkpoint per task …
final                        → thread verdict + fresh diff review → Claude fixes real bugs → done
/tandem status               → 14 contacts, 41k tokens, 5h window 63 % left
```

Everything Codex writes lands in `.tandem/replies/`; everything Claude sends is kept in `.tandem/prompts/`. The `ledger.md` next to them is Claude's memory across context compaction and sessions; the Codex thread is Codex's memory.

---

## The runner

All Codex calls go through `scripts/tandem.mjs`. It prints exactly one JSON line (`{"ok":true,…}` or `{"ok":false,"error":"<code>","message":"…","hint":"…"}`) and exits 0 or 1. Run it from the project root or pass `--project <absolute path>`. Every path you pass must be absolute.

| Command | Purpose |
|---------|---------|
| `doctor` | Codex binary, version, login, live rate limits, project-in-TEMP check. |
| `start --summary-file <abs> [--effort medium]` | Creates `.tandem/`, starts the thread with the onboarding contract, writes the ledger, adds `.tandem/` to `.gitignore` in git repos. |
| `contact --kind checkpoint\|resume\|final --prompt-file <abs> [--effort] [--deadline-min] [--min-remaining] [--force]` | Resumes the thread with your prompt wrapped in the contact envelope; validates the verdict against the schema (one retry). |
| `plan-round --round 1\|2\|3 --plan-file <abs> [--matrix-file <abs>]` | Plan consensus round. Rounds 2 and 3 require the objection matrix. Returns `consensus`. |
| `review [--uncommitted \| --base <ref> \| --commit <sha>] [--title <t>]` | Fresh review thread with the verdict schema; Codex reads the diff itself; one schema retry by resuming that thread (git repos only). |
| `status [--human]` | Thread, mode, contacts, plan state, usage, remaining quota. |
| `mode begleiter\|plan\|sparring\|split`, `pause`, `unpause`, `stop` | State control. |
| `config --min-remaining <percent>` | Guard threshold (default 10). |
| `rotate --seed-file <abs> [--reason <text>]` | New thread seeded from a ledger summary; the old thread id is archived. |

### Contact envelope

Claude writes the prompt file; the runner wraps it with the contact id, the kind, the schema name and the output cap.

```markdown
## Baseline
git HEAD abc123
## Changed paths
- src/auth.ts
## Delta
Replaced the session cookie with a signed token; refresh moved to middleware.
## Test evidence
- `npm test` → exit 0
## Objection matrix
- C3-1 rejected: base rate already covered by the rate limiter · C3-2 deferred: after the migration
## Question
Does the refresh path leak the old cookie on logout?
```

### Verdict schema (strict)

```json
{
  "verdict": "CONCERN",
  "checked": ["src/auth.ts", "src/middleware/refresh.ts"],
  "points": [
    { "id": "C4-1", "severity": "MAJOR", "text": "Logout clears the token but not the refresh cookie.", "file": "src/auth.ts", "line": 88 }
  ],
  "residualRisk": "Token rotation under concurrent requests is untested."
}
```

Schemas live in `references/schemas/` and are strict-mode compatible with the OpenAI structured-output API (every property required, nullable fields as type arrays). Point caps (5 for verdicts, 8 for plan verdicts) are enforced by the runner's validator.

### Plan consensus

```text
plan-round --round 1 --plan-file <abs>                       # effort high
plan-round --round 2 --plan-file <abs> --matrix-file <abs>   # effort medium, matrix = "P1-1 → accepted: …"
plan-round --round 3 …                                       # last chance; then the user decides
```

`consensus` is `true` only when Codex says `APPROVE` **and** `criteria.blockersOpen = 0`, `sourcesRead = true`, `testStrategyFeasible = true`, a residual risk is named and no point is BLOCKER or MAJOR. Automode never executes irreversible steps (deploys, deleting user data, payments, outbound messages, production config) without a user stop; the plan marks them.

### Usage guard and cost counter

The runner talks JSON-RPC to `codex app-server` and reads `account/rateLimits/read` before **every** model call (the schema retry included). The answer contains both windows with `usedPercent` and `resetsAt`. Below the threshold you get:

```json
{"ok":false,"error":"quota_low","message":"Codex-Restnutzung im 5h-Fenster ist 4 % (Schwelle 10 %).","hint":"Kein Codex-Aufruf. … Reset um 2026-09-06T05:11:20.000Z. Mit --min-remaining 0 erzwingen, wenn es wirklich sein muss."}
```

If the query itself fails, the guard fails open and `status` shows the quota as unknown. Token usage comes from the `turn.completed` event of Codex's JSONL stream (fallback: the `tokens used` line on stderr, parsed locale-aware).

---

## Error codes

| Code | Meaning | What Claude does |
|------|---------|------------------|
| `quota_low` | Remaining quota under the threshold | Informs the user, works on without a contact, never forces unless asked |
| `quota` | Codex reported a usage limit despite the guard | Runner pauses tandem; `unpause` later |
| `thread_lost` | The thread cannot be resumed (Codex update, deleted session) | Writes a seed from the ledger and runs `rotate` |
| `timeout` | Deadline exceeded, process tree killed | One manual retry, never blind repeats |
| `invalid_output` | Answer did not match the schema after one retry | Reads the reply file, decides manually |
| `locked` | Another runner command is running | Waits |
| `paused` / `stopped` | tandem is paused or stopped | `unpause`, or `--force` for a single contact |
| `not_git` | `review` needs a git repository | Uses a second `final` contact with a diff excerpt |
| `codex_not_found` / `auth` | Codex missing or not logged in | `npm install -g @openai/codex`, `codex login` |

Failed contacts still consume their contact number and are recorded with their status, so the next attempt gets fresh files.

---

## Project layout

```text
scripts/
  tandem.mjs            CLI entry: arguments, dispatch, JSON output
  lib/                  args, paths, state (atomic + lock), codex adapter, rate limits, schema validator,
                        usage, prompts, exchange (the shared contact flow)
  commands/             doctor, start, contact, plan-round, review, status, control, rotate
references/
  schemas/              verdict.schema.json, plan-verdict.schema.json
  templates/            onboarding, contact envelope, plan round, matrix block, ledger template
  contracts.md          the contracts in prose (for Claude)
tests/
  fake-codex.mjs        simulates codex exec / resume / review / app-server / login
  *.test.mjs            64 tests, `node --test`
  smoke.mjs             opt-in end-to-end run against the real Codex (costs tokens)
docs/
  2026-09-06-tandem-design.md         design spec (German)
  plans/2026-09-06-tandem-core.md     implementation plan A with full code
SKILL.md                the skill Claude Code loads (German)
```

Inside a project, tandem keeps everything under `.tandem/` (state, lock, ledger, prompts, replies, plans, workers, design). It is local and gitignored; durable decisions belong in the project's own docs.

---

## Development

```bash
npm test                                   # 64 tests against the fake codex, no tokens spent
node tests/smoke.mjs C:\path\outside\TEMP  # real Codex, low effort, a few thousand tokens
```

The fake Codex is driven by environment variables (`FAKE_CODEX_MODE=hang|fail|thread_lost|quota|auth|invalid_json`, `FAKE_USED_PRIMARY`, `FAKE_RATELIMIT_MODE=error|silent|crash`, …) so every failure path is covered without touching the network. `TANDEM_CODEX_BIN` points the runner at any binary or `.mjs` file.

Verified against Codex CLI 0.153.2 on 2026-09-06: cross-process `codex exec resume`, `--output-schema` with strict schemas, `account/rateLimits/read` over the app-server, and the Windows restricted-token sandbox confining `workspace-write` to the working directory (as long as the project is not under `%TEMP%`). Also verified, the hard way: `codex exec review` ignores `--output-schema` and answers in prose, which is why the final review runs as a plain `codex exec` thread with its own review contract.

---

## Credits

Built by [Sophey3dx](https://github.com/Sophey3dx) with Claude (Anthropic). The design and the implementation plan were each reviewed by Codex through the sibling skill *duofold*; ten findings from that review (atomic lock, budget check per attempt, failure accounting, plan-state safety and more) shaped this release.

## License

MIT, see [LICENSE](LICENSE).
