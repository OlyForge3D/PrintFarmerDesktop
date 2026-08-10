// An optional callback threaded through a constructor argument and assigned
// by the class itself. Ordinary dependency injection, not a seam waiting for
// an external prototype patch.
export class Logger {
  readonly onFlush?: () => void;

  constructor(options: { onFlush?: () => void }) {
    if (options.onFlush) {
      this.onFlush = options.onFlush;
    }
  }

  flush(): void {
    this.onFlush?.();
  }
}
