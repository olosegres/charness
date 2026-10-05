/**
 * @description One session transition at a time per conversation (plan
 * 2026-10-04-claude-process-lifecycle, L2 review / L3): a start, a resume and an
 * idle stop of the same key are chained, never run side by side. Two triggers
 * that hit a sleeping topic together both ask for a resume; the second runs
 * after the first and finds the session live. A trigger that arrives while the
 * idle stop runs waits for it, then resumes. A transition that throws does not
 * block the next one.
 */
export class KeyedTransitionQueue {
  /** Per key, a promise that settles (never rejects) once the last queued transition did. */
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `transition` once every transition queued before it for `key` has settled. */
  run<TResult>(key: string, transition: () => Promise<TResult>): Promise<TResult> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(transition);
    const settled = next.then(() => undefined, () => undefined);
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }

  /** Whether a transition of `key` is running or queued. */
  checkIsInFlight(key: string): boolean {
    return this.tails.has(key);
  }
}
