export class TandemError extends Error {
  constructor(code, message, hint = null, extra = {}) {
    super(message);
    this.name = "TandemError";
    this.code = code;
    this.hint = hint;
    this.extra = extra;
  }
}

export function printResult(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function printError(error) {
  const payload =
    error instanceof TandemError
      ? { ok: false, error: error.code, message: error.message, hint: error.hint, ...error.extra }
      : { ok: false, error: "internal", message: String(error?.stack ?? error?.message ?? error), hint: null };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
