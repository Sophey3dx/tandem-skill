#!/usr/bin/env node
// Stand-in for `systemd-run --user --scope … -- <cmd> [args]` (tests only): runs the command with inherited
// stdio and exits with its code. FAKE_SYSTEMD_RUN_LOG receives the arguments.
import { spawn } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_SYSTEMD_RUN_LOG) fs.appendFileSync(process.env.FAKE_SYSTEMD_RUN_LOG, `${JSON.stringify({ argv })}\n`);
if (argv[0] === "--version") {
  process.stdout.write("systemd 999 (fake)\n");
  process.exit(0);
}
const dash = argv.indexOf("--");
if (dash === -1 || dash === argv.length - 1) {
  process.stderr.write("fake systemd-run: no command\n");
  process.exit(2);
}
const [cmd, ...args] = argv.slice(dash + 1);
const child = spawn(cmd, args, { stdio: "inherit", windowsHide: true });
child.on("error", () => process.exit(127));
child.on("exit", (code) => process.exit(code ?? 1));
