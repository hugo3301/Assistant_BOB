export class BobError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'BobError'; this.code = code; this.details = details; }
}
export function requireThat(condition, code, message, details) { if (!condition) throw new BobError(code, message, details); }
