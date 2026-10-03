/**
 * @description Post a prompt into a conversation's agent session (Jira connector
 * plan J5, D21): make sure a session is ready — resuming the conversation's own
 * session when the deps can, else starting one if needed — let a
 * BUSY session finish its turn (up to {@link waitIdleTimeoutMs} — live work is
 * never interrupted on purpose; after the bound the forward takes the normal
 * interrupt path), then forward. The scheduler's fire (steps 3–4) and the Jira
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

export type EnsureSessionResult = { ok: true } | { ok: false; reason: EnsureSessionFailureReason };

/**
 * @name PostToSessionDeps
 * @description `conversationKey` is the serialized `SessionKey`; the bot's
 * lambdas parse it back where needed.
 */
export interface PostToSessionDeps {
  /** Whether the conversation's agent is mid-turn right now (sync, in-memory probe). */
  checkBusy: (conversationKey: string) => boolean;
  /**
   * Optional: bring the conversation's OWN session back when it is not running,
   * by resuming its persisted id — a tracker issue keeps one conversation for
   * good (Jira plan D5), so a session that died between requests must not be
   * replaced by a fresh one. Resolves whether or not it resumed; `ensureSession`
   * then finds the session live, or starts one when there was nothing to resume.
   */
  resumeSession?: (conversationKey: string) => Promise<void>;
  /** Ensure a session is ready, starting one with `fallbackAdapterName` if needed. */
  ensureSession: (conversationKey: string, fallbackAdapterName?: string) => Promise<EnsureSessionResult>;
  /** Forward the prompt to the conversation's agent. */
  forwardPrompt: (conversationKey: string, text: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** @name PostToSessionResult @description `forward-failed` carries the forward's own error message. */
export type PostToSessionResult =
  | { ok: true }
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
  text: string,
  fallbackAdapterName?: string,
): Promise<PostToSessionResult> {
  if (deps.resumeSession) await deps.resumeSession(conversationKey);
  const session = await deps.ensureSession(conversationKey, fallbackAdapterName);
  if (!session.ok) return { ok: false, reason: session.reason };
  if (deps.checkBusy(conversationKey)) await waitForIdle(deps, conversationKey);
  try {
    await deps.forwardPrompt(conversationKey, text);
  } catch (error) {
    return { ok: false, reason: 'forward-failed', error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}
