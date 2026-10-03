import { keyFromString, keyToString, type SessionKey } from './sessionKey';
import { checkIsTelegramKey } from './connectors/telegram/sessionKeyCodec';
import { maxTimeoutMs } from './scheduler/engine';
import type { UsageLimitWait } from './requests/limitWaitAnswer';
import type { BufferedPromptSettled } from './startupPromptBuffer';
import type { PromptDelivery } from './utils/promptDelivery';
import type { AgentApiErrorClass, ApiRetryState } from './types';

/**
 * The retry kick and the boot restore of the API-error auto-retry (plan S4–S6),
 * lifted out of `bot.ts` behind injected ports so the whole lifecycle — arm, fire,
 * restart — runs in a test. `apiErrorRetry.ts` holds the pure decisions and
 * `bot.ts` still arms and cancels a retry; this file owns what happens when its
 * timer fires and when the bot comes back up.
 */

/**
 * Catch-up delay for a retry whose `fireAt` is already in the past at boot.
 * Small (not zero) so the kick is armed via `setTimeout` instead of firing
 * synchronously in the adopt tick — a freshly-adopted Claude pane may still be
 * repainting, and the Enter-verification in `sendInput` covers the residual race.
 */
export const apiRetryCatchUpDelayMs = 5_000;

/**
 * @description One thread's live armed-retry timer + bookkeeping. The persisted
 * twin lives in `state.json` (`ApiRetryState`); this in-memory entry additionally
 * holds the actual `NodeJS.Timeout` (not serialisable) and `firedAt` (set when
 * the timer fires) so `decideRetryAction` can tell a same-episode recurrence
 * (escalate) from a fresh one (reset to attempt 1).
 */
export interface ApiRetryTimerEntry {
  /** The armed timer, or `null` once it has fired (record kept until outcome known). */
  timer: NodeJS.Timeout | null;
  /** 1-based attempt the current/last timer was armed for. */
  attempt: number;
  /** Error class that armed it. */
  kind: AgentApiErrorClass['kind'];
  /** Epoch ms when the timer fired, or `null` while still pending. */
  firedAt: number | null;
  /** Epoch ms the timer is due (mirrors the persisted `fireAt`). It IDENTIFIES the
   *  episode for the «skip once» button, whose stale keyboard must never cancel a
   *  later one. */
  fireAt: number;
  /** How a usage-limit wait ends, for the limit answer of a request opened during it.
   *  Absent for a record re-armed at boot (`state.json` keeps only the instant). */
  limitWait?: UsageLimitWait;
}

/** What the kick needs to know of {@link ensureAgentSession}'s answer. */
export type ApiRetryEnsureOutcome = { ok: true } | { ok: false; reason: string; message: string };

/** A message the kick posts into a topic (Telegram only — a tracker issue has no topic, R6). */
export type ApiRetryTopicNotice =
  | { kind: 'noSession'; message: string }
  | { kind: 'resuming'; retryKind: AgentApiErrorClass['kind'] };

/**
 * @name ApiRetryKickDeps
 * @description The ports of {@link runApiRetryKick}: `entries` and `kicksInFlight`
 * are the bot's own retry map and in-flight set (the wake-up probe reads the set);
 * everything else acts on the world — the session, the topic, the request ledger.
 */
export interface ApiRetryKickDeps {
  entries: Map<string, ApiRetryTimerEntry>;
  /** Threads whose timer fired and whose "continue" nudge is not handed over yet. */
  kicksInFlight: Set<string>;
  now: () => number;
  /** A tracker issue's own session, back before the nudge (R26). */
  resumeOwnSession: (key: SessionKey) => Promise<void>;
  ensureSession: (key: SessionKey) => Promise<ApiRetryEnsureOutcome>;
  postTopicNotice: (key: SessionKey, notice: ApiRetryTopicNotice) => void;
  /** The nudge, or the open request's own prompt the agent never took in (R21). */
  getResumeMessage: (key: SessionKey, retryKind: AgentApiErrorClass['kind']) => { text: string; isRequestPrompt: boolean };
  /** Through the startup buffer when another caller's start is still under way; a `buffered` nudge
   *  tells `onBufferedSettled` how its wait ended. */
  deliverNudge: (key: SessionKey, text: string, onBufferedSettled: BufferedPromptSettled) => Promise<PromptDelivery>;
  trackContinuation: (key: SessionKey, options: { isCountersReset: boolean; isRequestPrompt: boolean }) => Promise<void>;
  /** Drop the retry's saved twin (`state.json`). */
  clearSavedRetry: (key: SessionKey) => void;
}

/**
 * @description The retry kick (timer callback): make sure a session is up (after
 * an OpenCode `session.error` it still is, so `ensureSession` is a no-op and the
 * nudge lands in the SAME live session — context intact; only a genuinely-dead
 * session is restarted via the thread's last adapter), tell the topic we're
 * resuming, then hand over a neutral "continue" nudge. With no session to resume
 * the topic gets the reason instead and nothing is forwarded.
 *
 * The saved record means ARMED, so once the kick has run its course — the nudge
 * forwarded to the session, no session to nudge, or a delivery that threw — the saved
 * twin goes: left behind, every restart would restore it as armed and fire the kick
 * again (a second "resuming" notice, a second nudge into the topic or the issue's
 * session). A nudge that only waits in the startup buffer behind another caller's
 * session start has NOT run its course: the buffer is in memory, a restart loses it,
 * and a fresh spawn lays the session log out anew, so the boot recovery finds no error
 * to resume from either — the saved record is the only thing that fires it again. It
 * stays until the buffer settles the nudge: `replayed` (handed to the session — a
 * failed forward counts, as a direct delivery that threw does) or `dropped` (the start
 * failed, or the session is not up when the window closes — the same as "no session to
 * nudge": the starter reported the failure, an open request is left to the wake-up
 * engine, and a record kept for a start that failed would only fire the kick again at
 * the next restart).
 *
 * It goes only if `entries` still holds THIS entry: a recurrence armed meanwhile (a
 * newer entry and its own saved record) or a cancel / give-up (entry gone, record
 * already cleared) must not be undone by an older kick. The in-memory entry itself is
 * intentionally KEPT after firing (timer nulled, `firedAt` stamped): a recurrence
 * within the grace window re-arms at attempt+1 — that memory is not persisted.
 */
export async function runApiRetryKick(deps: ApiRetryKickDeps, key: SessionKey): Promise<void> {
  const k = keyToString(key);
  const entry = deps.entries.get(k);
  if (!entry) return;
  // Claimed in the same tick the retry stops being armed (see `kicksInFlight`).
  deps.kicksInFlight.add(k);
  entry.timer = null;
  entry.firedAt = deps.now();

  const clearSavedRetryIfLive = (): void => {
    if (deps.entries.get(k) === entry) deps.clearSavedRetry(key);
  };
  let isNudgeBuffered = false;

  try {
    // R26: a tracker issue keeps one conversation for good (D5) — a fresh session
    // would not know the work the limit interrupted.
    if (!checkIsTelegramKey(key)) await deps.resumeOwnSession(key);
    const ensured = await deps.ensureSession(key);
    if (!ensured.ok) {
      // No session to nudge (unbound, no adapter, a start that failed): a forward would hit a dead adapter, and
      // watching a turn that never started would only mislead the wake-ups. The open request, if any, stays
      // open for the wake-up engine (its backstop / retries); what was held stays held for the next session.
      console.warn(`[apiRetry] not resuming ${k}: no session (${ensured.reason}); an open request is left to the wake-up engine`);
      // A topic is told why nothing resumed — it waits for the operator's next message now (R6: not a tracker issue).
      if (checkIsTelegramKey(key)) deps.postTopicNotice(key, { kind: 'noSession', message: ensured.message });
      return;
    }
    // Announced only once there is a session to resume: a pinned "resuming" over a start that failed would
    // read as work under way. The notices are topic messages (a pin among them): a tracker issue hears about
    // the wait from the request's own answer, and has no topic for the rest (R6).
    if (checkIsTelegramKey(key)) deps.postTopicNotice(key, { kind: 'resuming', retryKind: entry.kind });
    // The nudge is NOT a request: the open request (if any) continues under it. A
    // request whose prompt never reached the agent — the wait held it (R23) — gets
    // that prompt instead (R21). Prompts held during the wait ride whichever it is.
    const resume = deps.getResumeMessage(key, entry.kind);
    const delivery = await deps.deliverNudge(key, resume.text, (outcome) => {
      if (outcome === 'dropped') {
        console.warn(`[apiRetry] nudge for ${k} dropped: the session did not come up; the retry is spent and an open request is left to the wake-up engine`);
      }
      clearSavedRetryIfLive();
    });
    isNudgeBuffered = delivery === 'buffered';
    await deps.trackContinuation(key, {
      isCountersReset: entry.kind === 'usageLimit',
      isRequestPrompt: resume.isRequestPrompt,
    });
  } catch (e) {
    console.error('[apiRetry] kick failed:', e instanceof Error ? e.message : e);
  } finally {
    deps.kicksInFlight.delete(k);
    // A buffered nudge keeps the record: the buffer's settle callback clears it.
    if (!isNudgeBuffered) clearSavedRetryIfLive();
  }
}

/**
 * @name ApiRetryRestoreDeps
 * @description The ports of {@link restoreApiRetryTimers}: the bot's retry map,
 * a clock, the served-platform filter and what a due timer does.
 */
export interface ApiRetryRestoreDeps {
  entries: Map<string, ApiRetryTimerEntry>;
  now: () => number;
  isServed: (key: SessionKey) => boolean;
  /** A due timer: run the kick for `key`. */
  fire: (key: SessionKey) => void;
}

/**
 * @description Re-arm persisted API-error retries (S6) so a pending kick —
 * especially a multi-hour usage-limit wait — survives a bot restart. The caller
 * runs it AFTER the sessions are reattached, so each kick lands in a live session.
 *
 * For each record we re-populate `entries` and arm one unref'd timer at
 * `fireAt - now` (clamped to `maxTimeoutMs`). A `fireAt` already in the past fires
 * ONE catch-up after {@link apiRetryCatchUpDelayMs}. The arm notice is NOT re-posted
 * (the user saw it before the restart); the `↻ resuming` notice fires when the
 * timer fires.
 *
 * A retry of a platform this instance does not serve is neither armed nor dropped
 * (Jira plan J3b, R10): its kick would start that conversation's session here,
 * under this instance's environment and tmux server. Returns how many were re-armed.
 */
export function restoreApiRetryTimers(deps: ApiRetryRestoreDeps, records: Readonly<Record<string, ApiRetryState>>): number {
  let restored = 0;
  for (const [keyStr, record] of Object.entries(records)) {
    let key: SessionKey;
    try {
      key = keyFromString(keyStr);
    } catch {
      // Hand-edited / corrupt key (can't come from `keyToString`): skip it,
      // keep booting. Tolerated-and-skipped, like restorePendingQuestions.
      continue;
    }
    if (!deps.isServed(key)) continue;
    const dueInMs = record.fireAt - deps.now();
    const delayMs = dueInMs > 0 ? Math.min(dueInMs, maxTimeoutMs) : apiRetryCatchUpDelayMs;
    const timer = setTimeout(() => {
      deps.fire(key);
    }, delayMs);
    timer.unref?.();
    deps.entries.set(keyStr, {
      timer,
      attempt: record.attempt,
      kind: record.kind,
      firedAt: null,
      fireAt: record.fireAt,
    });
    restored += 1;
  }
  return restored;
}
