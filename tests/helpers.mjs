import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(TESTS_DIR, "..");
export const RUNNER = path.join(SKILL_ROOT, "scripts", "tandem.mjs");
export const FAKE = path.join(TESTS_DIR, "fake-codex.mjs");
export const TMP_ROOT = path.join(TESTS_DIR, ".tmp");

export function makeProject(name = "proj") {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
}

export function writeFile(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

export function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function runTandem(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TANDEM_CODEX_BIN: FAKE, ...env }
  });
  const line = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  let json = null;
  try {
    json = JSON.parse(line);
  } catch {
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

// A real git repository with one commit on `main` (review needs resolvable refs).
export function initGitRepo(dir) {
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "tandem test");
  git("config", "commit.gpgsign", "false");
  writeFile(dir, "README.md", "# fixture\n");
  git("add", "-A");
  const commit = git("commit", "-q", "-m", "init");
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  return dir;
}

export function startProject(dir, env = {}) {
  const summary = writeFile(dir, "summary.md", "Testprojekt: kleine Node-Bibliothek, Tests mit node:test.");
  const result = runTandem(["start", "--summary-file", summary], { cwd: dir, env });
  if (!result.json?.ok) throw new Error(`start failed: ${result.stdout}\n${result.stderr}`);
  return result.json;
}
