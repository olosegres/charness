/**
 * @description Post a prompt into a conversation's agent session (Jira connector
 * plan J5, D21): make sure a session is ready — the ensure resumes the
 * conversation's own sleeping session, else starts one if needed — let a
 * BUSY session finish its turn (up to {@link waitIdleTimeoutMs} — live work is
 * never interrupted on purpose; after the bound the forward takes the normal
 * interrupt path) and ensure the session again once it did (the stop that
 * follows a per-turn conversation's turn may have put it to sleep), then forward —
 * unless an armed usage-limit wait holds the prompt, checked before the session
 * is touched and again right before the forward (R23). The scheduler's fire
 * (steps 3–4) and the Jira connector's requests share it. Every side effect is
 * injected, so the wait loop runs on a fake clock in tests.
 */

/** Poll cadence for the wait-for-idle loop: re-check the busy probe every 5s. */
export const busyPollIntervalMs = 5000;

/**
 * Upper bound on waiting for a busy session to go idle before forwarding anyway
 * (10 min). The forward then takes the normal interrupt path, so a wedged turn
 * never blocks a post forever.
 */
export const waitIdleTimeoutMs = 10 * 60 * 1000;

/** The wait windows in force: the two constants above, or a test instance's shorter ones ({@link registerPostWaitWindows}). */
let effectiveBusyPollIntervalMs = busyPollIntervalMs;
let effectiveWaitIdleTimeoutMs = waitIdleTimeoutMs;

/**
 * @description Register a test instance's shorter wait for a busy session (`CHARNESS_TEST_TIMINGS` `postBusyPollMs` and
 * `postWaitForIdleMs`), so a flow can have a scheduled prompt written to a session whose turn is blocked on a question inside
 * the question wait instead of 10 minutes after it. Never called in production.
 */
export function registerPostWaitWindows(windows: { busyPollMs?: number; waitForIdleMs?: number }): void {
  effectiveBusyPollIntervalMs = windows.busyPollMs ?? busyPollIntervalMs;
  effectiveWaitIdleTimeoutMs = windows.waitForIdleMs ?? waitIdleTimeoutMs;
}

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
  /**
   * Optional: resolves once no command ends or replaces the conversation (`ConversationEndings.waitForMessagesAccepted`). Awaited before
   * the post's first ensure and again before its second ensure and its write: a post that comes during a move to the other backend would otherwise
   * start the new backend with its own ensure and reach it AHEAD of the move's bridge (review 26 #5); after a release it goes to what
   * follows. Never called inside the conversation's transition queue, so no transition waits for it.
   */
  waitForConversationChange?: (conversationKey: string) => Promise<void>;
  /**
   * Optional: the wake-up engine settles the conversation's watches whose turn already ENDED (`settleEndedTurnsOf`), awaited right
   * before the text is built — after the wait for a busy turn, which this post ends within seconds of the idle, usually before the
   * engine's own tick saw it. The pick of the request a fire rides and its header then read what the ended turn decided (a scheduler's
   * request that closed is not ridden), and the new turn never runs under the old watch. It resolves the delivery of the wake-ups it
   * decided — with the ones handed to this post while it was in flight ({@link notePostInFlight}) — which this post runs AFTER its own
   * forward and the caller's `afterForward`, on every way out once the settle ran, so the post's prompt starts the turn and a reminder
   * joins it. Neither rejects.
   */
  settleEndedTurns?: (conversationKey: string) => Promise<() => Promise<void>>;
  /**
   * Optional: this post is on its way to its write, from its first step to its last: until the returned release, a wake-up the
   * wake-up engine decides for the conversation — at the turn's end this post may be waiting for — is handed to it
   * (`RequestWakeUpEngine.notePostInFlight`) and comes back through {@link settleEndedTurns}. The release, run on every way out after
   * everything else, delivers what this post never took. Never rejects.
   */
  notePostInFlight?: (conversationKey: string) => () => Promise<void>;
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

/**
 * @name PostToSessionOptions
 * @description `heldText` — what a held prompt says when it arrives late (R27). `afterForward` — the caller's step once the prompt
 * is written (a tracker turn watches the turn it started), run before the settled reminders follow it: a reminder that joins the turn
 * is then watched after the post's own request, which started it. Its error is the post's: thrown back, after the reminders.
 */
export interface PostToSessionOptions {
  heldText?: string;
  afterForward?: () => Promise<void>;
}

async function waitForIdle(deps: PostToSessionDeps, conversationKey: string): Promise<void> {
  const deadline = deps.now() + effectiveWaitIdleTimeoutMs;
  while (deps.checkBusy(conversationKey)) {
    if (deps.now() >= deadline) return;
    await deps.sleep(effectiveBusyPollIntervalMs);
  }
}

export async function postToSession(
  deps: PostToSessionDeps,
  conversationKey: string,
  prompt: string | SessionPromptText,
  fallbackAdapterName?: string,
  options: PostToSessionOptions = {},
): Promise<PostToSessionResult> {
  // From the first step to the last, a reminder decided for this conversation waits for this post's write (`notePostInFlight`).
  const releasePost = deps.notePostInFlight?.(conversationKey);
  try {
    return await postWhileInFlight(deps, conversationKey, prompt, fallbackAdapterName, options);
  } finally {
    await releasePost?.();
  }
}

/** {@link postToSession} while it is in flight: the holds, the ensure, the wait for a busy turn, the settle, the forward. */
async function postWhileInFlight(
  deps: PostToSessionDeps,
  conversationKey: string,
  prompt: string | SessionPromptText,
  fallbackAdapterName: string | undefined,
  options: PostToSessionOptions,
): Promise<PostToSessionResult> {
  // What is held is read only once the wait is over: a caller may say when it was due (R27).
  const { heldText, afterForward } = options;
  const text = typeof prompt === 'string' ? prompt : prompt.fullText;
  // A command that ends or replaces the conversation first: what the post ensures and writes into is the conversation that follows it.
  await deps.waitForConversationChange?.(conversationKey);
  // Checked first: no session is started or resumed into a limit.
  if (deps.holdForLimitResume?.(conversationKey, text, heldText)) return { ok: true, isHeld: true };
  const session = await deps.ensureSession(conversationKey, fallbackAdapterName);
  if (!session.ok) return { ok: false, reason: session.reason };
  const isWaitingForTurn = deps.checkBusy(conversationKey);
  if (isWaitingForTurn) await waitForIdle(deps, conversationKey);
  // Ahead of the second limit check, the ensure and the text: the decisions are persisted now, their reminders delivered after the forward.
  const deliverSettledWakes = await deps.settleEndedTurns?.(conversationKey);
  try {
    return await forwardAfterSettle(deps, conversationKey, prompt, fallbackAdapterName, { text, heldText, isWaitingForTurn, isFresh: session.isFresh, afterForward });
  } finally {
    await deliverSettledWakes?.();
  }
}

/**
 * @name ForwardAfterSettleContext
 * @description What {@link postToSession} learned before its settle: the prompt's standalone `text` and `heldText`, whether it
 * waited for a busy turn, whether the ensure started a fresh conversation, and the caller's `afterForward` step.
 */
interface ForwardAfterSettleContext {
  text: string;
  heldText: string | undefined;
  isWaitingForTurn: boolean;
  isFresh: boolean;
  afterForward: (() => Promise<void>) | undefined;
}

/** The rest of {@link postToSession} once the ended turns are settled: the second limit check, the second ensure, the forward, `afterForward`. */
async function forwardAfterSettle(
  deps: PostToSessionDeps,
  conversationKey: string,
  prompt: string | SessionPromptText,
  fallbackAdapterName: string | undefined,
  context: ForwardAfterSettleContext,
): Promise<PostToSessionResult> {
  const { text, heldText, isWaitingForTurn } = context;
  // Again before the second ensure and the write: a move that began while the post waited for the busy turn starts the new backend and
  // writes its bridge first — an ensure of this post's own would start it ahead of the move's, with the move's start text left out.
  await deps.waitForConversationChange?.(conversationKey);
  // Again: the turn waited out above may itself have hit the limit and armed a wait.
  if (deps.holdForLimitResume?.(conversationKey, text, heldText)) return { ok: true, isHeld: true };
  let { isFresh } = context;
  if (isWaitingForTurn) {
    // The session found live may be asleep by now: a per-turn conversation stops its process right after the turn
    // waited out above, and a prompt written to the stopped process is dropped. The ensure queues behind a stop in
    // progress, resumes the session when it is over, and is a no-op on a live one. It cannot slip in BESIDE the stop:
    // the stop is queued in the same tick the turn ends (`handleAgentTurnEnded`), before any poll can see the idle.
    const woken = await deps.ensureSession(conversationKey, fallbackAdapterName);
    if (!woken.ok) return { ok: false, reason: woken.reason };
    isFresh = isFresh || woken.isFresh;
  }
  try {
    await deps.forwardPrompt(conversationKey, typeof prompt === 'string' ? prompt : prompt.buildText({ isFresh }));
  } catch (error) {
    return { ok: false, reason: 'forward-failed', error: error instanceof Error ? error.message : String(error) };
  }
  await context.afterForward?.();
  return { ok: true, isHeld: false };
}

/**
 * @name PostToIdleSessionDeps
 * @description `checkIsIdle` = the session is live and not working right now; `forward` writes the prompt.
 */
export interface PostToIdleSessionDeps {
  checkIsIdle: () => boolean;
  forward: () => Promise<void>;
}

/**
 * @description The idle-only sibling of {@link postToSession} for a bot-made technical prompt (the todo list's
 * staleness reminder): it never ensures, resumes or starts a session and never waits for a turn — a session that is
 * not idle at this moment gets nothing (`false`). A forward that throws is logged and reads as not posted.
 */
export async function postToIdleSession(deps: PostToIdleSessionDeps): Promise<boolean> {
  if (!deps.checkIsIdle()) return false;
  try {
    await deps.forward();
    return true;
  } catch (error) {
    console.warn('[postToIdleSession] the forward failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
