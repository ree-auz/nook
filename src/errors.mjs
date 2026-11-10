// @ts-check
/** An expected failure: printed as one line, without a stack trace. */
export class NookError extends Error {
  constructor(message, { code = 1 } = {}) {
    super(message);
    this.name = "NookError";
    this.code = code;
  }
}
