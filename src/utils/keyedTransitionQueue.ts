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
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Run `transition` once every transition queued before it for `key` has settled. */
  run<TResult>(key: string, transition: () => Promise<TResult>): Promise<TResult> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(transition);
    this.tails.set(key, next);
    const release = (): void => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    };
    next.then(release, release);
    return next;
  }

  /** Whether a transition of `key` is running or queued. */
  checkIsInFlight(key: string): boolean {
    return this.tails.has(key);
  }
}
