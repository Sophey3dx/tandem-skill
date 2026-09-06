export function parseArgs(argv, { flags = [] } = {}) {
  const flagSet = new Set(flags);
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      options[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (flagSet.has(body)) {
      options[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[body] = true;
      continue;
    }
    options[body] = next;
    i += 1;
  }
  return { positionals, options };
}
