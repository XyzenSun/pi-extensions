export class InjectedFailure extends Error {
  constructor(
    readonly operation: string,
    readonly occurrence: number,
    message = `Injected failure at ${operation}#${occurrence}`,
  ) {
    super(message);
    this.name = "InjectedFailure";
  }
}

interface FailureRule {
  occurrence: number;
  error: Error;
}

/**
 * Deterministic failure injector for adapter-level tests. Production adapters can
 * call checkpoint() before an I/O boundary; no timing or filesystem permissions
 * are needed to exercise partial-failure recovery paths.
 */
export class FailureInjector {
  readonly calls: string[] = [];
  private readonly occurrences = new Map<string, number>();
  private readonly rules = new Map<string, FailureRule>();

  failOn(operation: string, occurrence = 1, error?: Error): void {
    this.rules.set(operation, {
      occurrence,
      error: error ?? new InjectedFailure(operation, occurrence),
    });
  }

  checkpoint(operation: string): void {
    const occurrence = (this.occurrences.get(operation) ?? 0) + 1;
    this.occurrences.set(operation, occurrence);
    this.calls.push(`${operation}#${occurrence}`);

    const rule = this.rules.get(operation);
    if (rule?.occurrence === occurrence) throw rule.error;
  }
}
