/**
 * @description Post a prompt into a conversation's agent session (Jira connector
 * plan J5, D21): make sure a session is ready — the ensure resumes the
 * conversation's own sleeping session, else starts one if needed — let a
 * BUSY session finish its turn (up to {@link waitIdleTimeoutMs} — live work is
 * never interrupted on purpose; after the bound the forward takes the normal
 * interrupt path), then forward — unless an armed usage-limit wait holds the
 * prompt, checked before the session is touched and again right before the
 * forward (R23). The scheduler's fire (steps 3–4) and the Jira
 * connector's requests share it. Every side effect is injected, so the wait
 * loop runs on a fake clock in tests.
 */

/** Poll cadence for the wait-for-idle loop: re-check the busy probe every 5s. */
export const busyPollIntervalMs = 5000;

/**
 * Upper bound on waiting for a busy session to go idle before forwarding anyway
 * (10 min). The forward then takes the normal interrupt path, so a wedged turn
 * never blocks a post forever.
 */
export const waitIdleTimeoutMs = 10 * 60 * 1000;

/**
 * @name EnsureSessionResult
 * @description What {@link PostToSessionDeps.ensureSession} reports back. It
 * mirrors bot.ts's `ensureAgentSession` outcome without importing it: `ok` means
 * a session is ready (active, mid-startup, or just started — a prompt forwarded
 * now is delivered or buffered-then-replayed); `unbound`/`no-adapter`/
 * `start-failed` are the three failure reasons (`no-adapter` = a bound
 * conversation that never picked an agent, with no fallback adapter given).
 */
export type EnsureSessionFailureReason = 'unbound' | 'no-adapter' | 'start-failed';

/** `isFresh` — the ensure started a NEW conversation (a start, or a resume that failed and fell back to one). */
export type EnsureSessionResult = { ok: true; isFresh: boolean } | { ok: false; reason: EnsureSessionFailureReason };

/**
 * @name SessionPromptText
 * @description A prompt whose text depends on the session it lands in (Jira prompt
 * context C5): `buildText` runs right before the forward — after the ensure, the
 * wait for idle and the second limit check — and is told whether the session is
 * fresh; `fullText` is what stands on its own (a hold keeps it, a re-post sends it).
 */
export interface SessionPromptText {
  fullText: string;
  buildText: (context: { isFresh: boolean }) => string;
}

/**
 * @name PostToSessionDeps
 * @description `conversationKey` is the serialized `SessionKey`; the bot's
 * lambdas parse it back where needed.
 */
export interface PostToSessionDeps {
  /**
   * Optional: hold the prompt while the conversation waits out an armed usage
   * limit (Jira plan R23) — posting it would only hit the limit again; it reaches
   * the session once the wait ends. `true` = held, nothing else to do now.
   * `heldText` — what it says when it arrives late (R27); the run is `text`.
   */
  holdForLimitResume?: (conversationKey: string, text: string, heldText?: string) => boolean;
  /** Whether the conversation's agent is mid-turn right now (sync, in-memory probe). */
  checkBusy: (conversationKey: string) => boolean;
  /** Ensure a session is ready: a sleeping one is resumed by its id (a tracker issue keeps one conversation for
   *  good, Jira plan D5); one with nothing to resume is started with `fallbackAdapterName`. */
  ensureSession: (conversationKey: string, fallbackAdapterName?: string) => Promise<EnsureSessionResult>;
  /** Forward the prompt to the conversation's agent. */
  forwardPrompt: (conversationKey: string, text: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * @name PostToSessionResult
 * @description `isHeld` — an armed usage-limit wait held the prompt; it reaches the
 * session once the wait ends. `forward-failed` carries the forward's own error message.
 */
export type PostToSessionResult =
  | { ok: true; isHeld: boolean }
  | { ok: false; reason: EnsureSessionFailureReason }
  | { ok: false; reason: 'forward-failed'; error: string };

async function waitForIdle(deps: PostToSessionDeps, conversationKey: string): Promise<void> {
  const deadline = deps.now() + waitIdleTimeoutMs;
  while (deps.checkBusy(conversationKey)) {
    if (deps.now() >= deadline) return;
    await deps.sleep(busyPollIntervalMs);
  }
}

export async function postToSession(
  deps: PostToSessionDeps,
  conversationKey: string,
  prompt: string | SessionPromptText,
  fallbackAdapterName?: string,
  options: { heldText?: string } = {},
): Promise<PostToSessionResult> {
  // What is held is read only once the wait is over: a caller may say when it was due (R27).
  const { heldText } = options;
  const text = typeof prompt === 'string' ? prompt : prompt.fullText;
  // Checked first: no session is started or resumed into a limit.
  if (deps.holdForLimitResume?.(conversationKey, text, heldText)) return { ok: true, isHeld: true };
  const session = await deps.ensureSession(conversationKey, fallbackAdapterName);
  if (!session.ok) return { ok: false, reason: session.reason };
  if (deps.checkBusy(conversationKey)) await waitForIdle(deps, conversationKey);
  // Again: the turn waited out above may itself have hit the limit and armed a wait.
  if (deps.holdForLimitResume?.(conversationKey, text, heldText)) return { ok: true, isHeld: true };
  try {
    await deps.forwardPrompt(conversationKey, typeof prompt === 'string' ? prompt : prompt.buildText({ isFresh: session.isFresh }));
  } catch (error) {
    return { ok: false, reason: 'forward-failed', error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, isHeld: false };
}
