import fs from "node:fs";
import path from "node:path";
import { TandemError } from "./output.mjs";
import { canonical, isUnder, isUnderTemp, tandemLayout } from "./paths.mjs";

export const FORBIDDEN_DIR_NAMES = new Set(["node_modules", "dist", "build", ".next", "target", ".git"]);
export const MAX_ACTIVE_WORKERS = 2;
const WALK_LIMIT = 20000;

function bad(message, hint = null) {
  return new TandemError("bad_zone", message, hint);
}

function lower(text) {
  return process.platform === "win32" ? text.toLowerCase() : text;
}

// Walks the zone. Fail-closed: anything that cannot be inspected rejects the zone, because the sandbox can
// only confine what we know about.
function walk(root) {
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw bad(`Zone contains an unreadable folder: ${dir} (${error.code ?? error.message})`, "Fix permissions or choose another zone.");
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > WALK_LIMIT) throw bad(`Zone has more than ${WALK_LIMIT} entries: ${root}`, "Choose a smaller zone.");
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw bad(`Zone contains a symlink or junction: ${full}`, "Remove it or choose another zone.");
      if (entry.isDirectory()) {
        if (FORBIDDEN_DIR_NAMES.has(lower(entry.name))) throw bad(`Zone contains a shared build/cache/VCS folder: ${full}`, "Workers must not touch node_modules, dist, build, .next, target or .git.");
        stack.push(full);
      }
    }
  }
}

export function checkZone({ project, zone, activeZones = [] }) {
  if (!zone || typeof zone !== "string" || !path.isAbsolute(zone)) throw bad(`Zone must be an absolute path, got: ${zone}`, "Pass an absolute folder inside the project.");
  const resolved = path.resolve(zone);
  const projectResolved = path.resolve(project);
  if (!isUnder(resolved, projectResolved) || canonical(resolved) === canonical(projectResolved)) throw bad(`Zone must lie inside the project and must not be the project root: ${resolved}`, "Choose a sub-folder of the project.");
  if (isUnderTemp(resolved)) throw bad(`Zone lies under a TEMP directory: ${resolved}`, "workspace-write sandboxes cannot confine writes under TEMP. Move the project.");
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw bad(`Zone does not exist: ${resolved}`, "Create the folder first.");
  }
  if (stat.isSymbolicLink()) throw bad(`Zone is a symlink or junction: ${resolved}`, "Use the real folder.");
  if (!stat.isDirectory()) throw bad(`Zone is not a directory: ${resolved}`);
  // Real paths: an ancestor between project and zone may be a junction, so the real zone could lie elsewhere.
  let realProject;
  let realZone;
  try {
    realProject = fs.realpathSync.native(projectResolved);
    realZone = fs.realpathSync.native(resolved);
  } catch (error) {
    throw bad(`Cannot resolve the real path of the zone: ${error.message}`);
  }
  if (!isUnder(realZone, realProject) || canonical(realZone) === canonical(realProject)) throw bad(`Zone resolves outside the project: ${realZone}`, "An ancestor of the zone is a junction or symlink. Use a real folder.");
  if (lower(path.relative(realProject, realZone)) !== lower(path.relative(projectResolved, resolved))) throw bad(`Zone path crosses a symlink or junction: ${resolved} → ${realZone}`, "Use the real folder path.");
  if (isUnderTemp(realZone)) throw bad(`Zone resolves under a TEMP directory: ${realZone}`);
  const layout = tandemLayout(realProject);
  if (isUnder(realZone, layout.root)) {
    // The only zones allowed under .tandem/ are design rounds' Codex variants: .tandem/design/<N>/codex
    const parts = isUnder(realZone, layout.design) && canonical(realZone) !== canonical(layout.design) ? path.relative(layout.design, realZone).split(/[\\/]+/) : [];
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || lower(parts[1]) !== "codex") {
      throw bad(`Zone must not lie inside .tandem/ (only .tandem/design/<N>/codex is allowed): ${realZone}`);
    }
  }
  for (const segment of path.relative(realProject, realZone).split(/[\\/]+/)) {
    if (FORBIDDEN_DIR_NAMES.has(lower(segment))) throw bad(`Zone lies inside a shared build/cache/VCS folder (${segment}): ${realZone}`, "Zones must not touch node_modules, dist, build, .next, target or .git.");
  }
  for (const active of activeZones) {
    if (isUnder(realZone, active) || isUnder(active, realZone)) throw bad(`Zone overlaps an active worker zone: ${active}`, "Wait for that worker (`worker wait <id>`) or choose a disjoint folder.");
  }
  walk(realZone);
  return realZone;
}
