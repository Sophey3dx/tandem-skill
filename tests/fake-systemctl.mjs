#!/usr/bin/env node
// Stand-in for `systemctl` (tests only). Env switches:
//   FAKE_SYSTEMCTL_KILL        ok | fail   exit code of `--user kill` (default ok)
//   FAKE_SYSTEMCTL_STATE_FILE  file whose first line is what `--user is-active` reports (default inactive)
//   FAKE_SYSTEMCTL_LOG         file that receives one JSON line per invocation
import fs from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_SYSTEMCTL_LOG) fs.appendFileSync(process.env.FAKE_SYSTEMCTL_LOG, `${JSON.stringify({ argv, at: new Date().toISOString() })}\n`);
const verb = argv.find((a) => !a.startsWith("--"));
if (verb === "is-system-running") {
  process.stdout.write("running\n");
  process.exit(0);
}
if (verb === "kill") process.exit((process.env.FAKE_SYSTEMCTL_KILL ?? "ok") === "ok" ? 0 : 1);
if (verb === "is-active") {
  let state = "inactive";
  try {
    state = fs.readFileSync(process.env.FAKE_SYSTEMCTL_STATE_FILE, "utf8").trim().split(/\r?\n/)[0] || "inactive";
  } catch {
    // default
  }
  process.stdout.write(`${state}\n`);
  process.exit(state === "active" ? 0 : 3);
}
process.stderr.write(`fake systemctl: unsupported ${argv.join(" ")}\n`);
process.exit(2);
