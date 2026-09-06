import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TandemError } from "./output.mjs";

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TEMPLATES_DIR = path.join(SKILL_ROOT, "references", "templates");
export const SCHEMAS_DIR = path.join(SKILL_ROOT, "references", "schemas");

export function canonical(p) {
  let resolved = path.resolve(p);
  if (process.platform === "win32") resolved = resolved.toLowerCase();
  return resolved.replace(/[\\/]+$/, "");
}

export function isUnder(child, parent) {
  const c = canonical(child);
  const p = canonical(parent);
  return c === p || c.startsWith(p + path.sep);
}

export function tempRoots() {
  const roots = [os.tmpdir()];
  for (const key of ["TEMP", "TMP", "TMPDIR"]) if (process.env[key]) roots.push(process.env[key]);
  return roots;
}

export function isUnderTemp(p) {
  return tempRoots().some((root) => isUnder(p, root));
}

export function tandemLayout(projectRoot) {
  const root = path.join(projectRoot, ".tandem");
  return {
    root,
    stateFile: path.join(root, "state.json"),
    backupFile: path.join(root, "state.json.bak"),
    lockFile: path.join(root, "lock"),
    ledgerFile: path.join(root, "ledger.md"),
    prompts: path.join(root, "prompts"),
    replies: path.join(root, "replies"),
    plans: path.join(root, "plans"),
    workers: path.join(root, "workers"),
    design: path.join(root, "design")
  };
}

export function ensureLayout(projectRoot) {
  const layout = tandemLayout(projectRoot);
  for (const dir of [layout.root, layout.prompts, layout.replies, layout.plans, layout.workers, layout.design]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return layout;
}

export function requireAbsolute(p, label) {
  if (!p || typeof p !== "string" || !path.isAbsolute(p)) {
    throw new TandemError("bad_path", `${label} must be an absolute path, got: ${p}`, "Pass an absolute path.");
  }
  return path.resolve(p);
}

export function stamp(n) {
  return String(n).padStart(4, "0");
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function ensureGitignoreEntry(projectRoot, entry) {
  if (!fs.existsSync(path.join(projectRoot, ".git"))) return false;
  const file = path.join(projectRoot, ".gitignore");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(entry.replace(/\/$/, ""))) return false;
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(file, `${current}${prefix}${entry}\n`, "utf8");
  return true;
}
