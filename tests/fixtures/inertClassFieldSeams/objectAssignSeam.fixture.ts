// An optional callback assigned via `Object.assign(this, { onFlush: ... })`
// is exactly as self-managed as `this.onFlush = ...` -- ordinary dependency
// injection via a bulk-assign helper, not a seam waiting for an external
// prototype patch. The original self-assignment detection only recognized
// direct assignment expressions, which made this a false positive.
export class ObjectAssignLogger {
  readonly onFlush?: () => void;

  constructor(options: { onFlush?: () => void }) {
    Object.assign(this, { onFlush: options.onFlush });
  }

  flush(): void {
    this.onFlush?.();
  }
}
