#!/usr/bin/env node
// Stand-in for `systemctl` (tests only). Env switches:
//   FAKE_SYSTEMCTL_KILL        ok | fail   exit code of `--user kill` (default ok)
//   FAKE_SYSTEMCTL_STATE_FILE  line 1: what `--user is-active` prints (default inactive);
//                              line 2 (optional): what `show -p LoadState --value` prints (default: not-found
//                              when line 1 is "unknown", loaded otherwise)
//   FAKE_SYSTEMCTL_LOG         file that receives one JSON line per invocation
import fs from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_SYSTEMCTL_LOG) fs.appendFileSync(process.env.FAKE_SYSTEMCTL_LOG, `${JSON.stringify({ argv, at: new Date().toISOString() })}\n`);
const verb = argv.find((a) => !a.startsWith("--") && !a.startsWith("-"));

function stateLines() {
  try {
    return fs.readFileSync(process.env.FAKE_SYSTEMCTL_STATE_FILE, "utf8").split(/\r?\n/).map((l) => l.trim());
  } catch {
    return [];
  }
}

if (verb === "is-system-running") {
  process.stdout.write("running\n");
  process.exit(0);
}
if (verb === "kill") process.exit((process.env.FAKE_SYSTEMCTL_KILL ?? "ok") === "ok" ? 0 : 1);
if (verb === "is-active") {
  const state = stateLines()[0] || "inactive";
  process.stdout.write(`${state}\n`);
  process.exit(state === "active" ? 0 : state === "unknown" ? 4 : 3);
}
if (verb === "show") {
  const lines = stateLines();
  const load = lines[1] || ((lines[0] || "inactive") === "unknown" ? "not-found" : "loaded");
  process.stdout.write(`${load}\n`);
  process.exit(0);
}
process.stderr.write(`fake systemctl: unsupported ${argv.join(" ")}\n`);
process.exit(2);
