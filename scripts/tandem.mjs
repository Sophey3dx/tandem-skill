#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import { TandemError, printError, printResult } from "./lib/output.mjs";
import { runDoctor } from "./commands/doctor.mjs";
import { runStart } from "./commands/start.mjs";
import { runContact } from "./commands/contact.mjs";
import { runPlanRound } from "./commands/plan-round.mjs";
import { runReview } from "./commands/review.mjs";
import { runStatus } from "./commands/status.mjs";
import { runControl } from "./commands/control.mjs";
import { runRotate } from "./commands/rotate.mjs";
import { runWorker } from "./commands/worker.mjs";
import { runLane } from "./commands/lane.mjs";

const FLAGS = ["human", "force", "uncommitted", "json"];

export const COMMANDS = {
  doctor: runDoctor,
  start: runStart,
  contact: runContact,
  "plan-round": runPlanRound,
  review: runReview,
  status: runStatus,
  mode: runControl,
  pause: runControl,
  unpause: runControl,
  stop: runControl,
  config: runControl,
  rotate: runRotate,
  worker: runWorker,
  lane: runLane
};

export async function main(argv) {
  const [command, ...rest] = argv;
  const { positionals, options } = parseArgs(rest, { flags: FLAGS });
  const project = path.resolve(options.project ?? process.cwd());
  if (!command || command === "help") {
    printResult({ ok: true, commands: Object.keys(COMMANDS), usage: "node tandem.mjs <command> [--project <abs>] [options]" });
    return 0;
  }
  if (!COMMANDS[command]) {
    printError(new TandemError("unknown_command", `Unknown command "${command}".`, `Use one of: ${Object.keys(COMMANDS).join(", ")}`));
    return 1;
  }
  try {
    const result = await COMMANDS[command]({ command, project, positionals, options });
    printResult({ ok: true, ...result });
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
