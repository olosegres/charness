/**
 * @description The longest the bot waits for the text an agent streamed before a tool call to land in the topic before it posts
 * what the call asks for (its answer, its messages, its question). The landing may take as long as Telegram does — a long text
 * goes out in several paced messages — but a send that never finishes must not hold the agent's tool call, and with it its
 * turn, for ever: a misplaced answer is better than a stuck agent.
 */
export const streamedOutputLandingLimitMs = 60_000;

/**
 * @description Start `land` now and resolve when it is over — it landed, it failed (logged, never thrown at the caller) or
 * {@link streamedOutputLandingLimitMs} passed (warned about; the landing goes on in the background and its late end changes
 * nothing). `owner` names the conversation in the log lines. Never rejects, so a caller may start it and await it later.
 */
export function landStreamedOutputWithinLimit(land: () => Promise<void>, owner: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const limitTimer = setTimeout(() => {
      console.warn(`[send] ${owner}: the streamed text was still going out ${streamedOutputLandingLimitMs / 1000} s after it was asked for — going on without waiting for it`);
      resolve();
    }, streamedOutputLandingLimitMs);
    const reportFailure = (error: Error | string | number | boolean | null | undefined): void => {
      console.error(`[send] ${owner}: the streamed text could not be landed before what follows it:`, error instanceof Error ? error.message : error);
    };
    const finish = (): void => {
      clearTimeout(limitTimer);
      resolve();
    };
    let landing: Promise<void>;
    try {
      landing = land();
    } catch (error) {
      reportFailure(error instanceof Error ? error : String(error));
      finish();
      return;
    }
    landing.then(finish, (error) => {
      reportFailure(error instanceof Error ? error : String(error));
      finish();
    });
  });
}
