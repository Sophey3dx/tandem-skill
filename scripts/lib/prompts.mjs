import fs from "node:fs";
import path from "node:path";
import { TEMPLATES_DIR } from "./paths.mjs";

export function loadTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, `${name}.md`), "utf8");
}

export function render(template, vars = {}) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => String(vars[key] ?? ""));
}

export function renderTemplate(name, vars = {}) {
  return render(loadTemplate(name), vars);
}
