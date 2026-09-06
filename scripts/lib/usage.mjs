export function usageFromEvents(events = []) {
  const done = [...events].reverse().find((e) => e?.type === "turn.completed" && e.usage);
  if (!done) return null;
  const input = Number(done.usage.input_tokens ?? 0);
  const output = Number(done.usage.output_tokens ?? 0);
  return { input, output, total: input + output, runs: 1 };
}

export function usageFromStderr(stderr = "") {
  const match = /tokens used\s*[\r\n]+\s*(\d[\d.,]*)/i.exec(stderr);
  if (!match) return null;
  const digits = match[1].replace(/[^\d]/g, "");
  if (!digits) return null;
  return { input: 0, output: 0, total: Number(digits), runs: 1 };
}

export function extractUsage({ events = [], stderr = "" }) {
  return usageFromEvents(events) ?? usageFromStderr(stderr);
}
