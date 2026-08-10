// An optional callback assigned via bracket/computed property access
// (`this['onFlush'] = ...`) is exactly as self-managed as the dotted form
// (`this.onFlush = ...`) -- ordinary dependency injection, not a seam
// waiting for an external prototype patch. The original self-assignment
// detection only recognized the dotted form, which made this a false
// positive (flagged as an inert seam when it was not one).
export class BracketAssignedLogger {
  readonly onFlush?: () => void;

  constructor(options: { onFlush?: () => void }) {
    if (options.onFlush) {
      this['onFlush'] = options.onFlush;
    }
  }

  flush(): void {
    this.onFlush?.();
  }
}
