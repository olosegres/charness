import { Markup, type Context } from 'telegraf';
import type { InlineKeyboardMarkup, Message } from 'telegraf/typings/core/types/typegram';
import { getThreadAdapter } from '../../../adapters/createAdapter';
// Decides whether the D3 summary guidance rides the compaction instruction: OpenCode bakes it into its fork
// compaction prompt (covering auto/overflow compaction too), the Claude backends need it every time.
import { claudePerTurnAdapterName, openCodeAdapterName } from '../../../adapters/adapterNames';
import type { AgentAdapter, PendingQuestionState, OpenCodeQuestion } from '../../../types';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { checkIsTelegramKey, getTelegramChatId } from '../sessionKeyCodec';
import { enqueueSend } from '../../../rateLimiter';
import { t } from '../../../i18n';
import { checkIsApiError, getErrorDescription } from '../../../sendErrorClassifier';
import { type CompactCommandRoute, getCompactCommandRoute } from '../../../utils/compactCommandRoute';
import {
  buildCompactionInstruction,
  compactionSummaryGuidance,
  compactionSkillsGuidance,
  compactionClosingStartMarker,
  compactionClosingEndMarker,
  stripCompactionClosingMarkers,
  checkShouldPostCompactionSummary,
  checkShouldAnnounceCompactionStart,
  buildIdleCompactionNoticeParts,
  formatTokenCount,
  type IdleCompactionArmKind,
  getIdleCompactionArmDecision,
  checkIsWorkingAtIdle,
  getIdleFireDecision,
} from '../../../utils/compactOnIdle';
import { buildQuestionOptionsKeyboard, buildKeyboardExtra } from '../questionKeyboards';
import { splitMessage, MAX_MESSAGE_LEN } from '../messageSplit';
import type { BotCore } from './botCore';

/** The literal slash command forwarded to backends whose own CLI parses it. */
const compactCommandText = '/compact';

/** `adapter.name` of the raw-shell backend (see the `terminal` adapter). */
const terminalAdapterName = 'terminal';


/**
 * @description Compose the per-invocation compaction instruction for a thread's
 * backend (D3 summary guidance + the loaded-skills guidance + the optional F2
 * closing section). The general guidance is skipped for OpenCode (baked in its
 * fork prompt) and appended for the Claude backends; the skills guidance is
 * skipped when the backend's own compaction prompt already gets it (an OpenCode
 * server running the bot's compaction plugin); the closing-section directive
 * rides only when requested.
 */
async function getCompactionInstruction(
  adapter: AgentAdapter,
  key: SessionKey,
  opts: { withClosingSection: boolean },
): Promise<string | undefined> {
  return buildCompactionInstruction({
    bakesSummaryGuidance: adapter.name === openCodeAdapterName,
    summaryGuidance: compactionSummaryGuidance,
    bakesSkillsGuidance: (await adapter.checkHasCompactionSkillsHook?.(key)) ?? false,
    skillsGuidance: compactionSkillsGuidance,
    closingSectionInstruction: opts.withClosingSection
      ? t('compact.closingSectionInstruction', {
          startMarker: compactionClosingStartMarker,
          endMarker: compactionClosingEndMarker,
        })
      : undefined,
  });
}

// ─── compaction orchestration (F1 tool + F2 idle) ───────────────────────────
//
// The manual `/compact` command reaches a real backend compaction directly (the
// handler below). The agent-triggered tool (F1) and the idle watchdog (F2) both
// funnel through the shared `runThreadCompaction` seam so the three triggers use
// ONE compaction path (plan 2026-09-14-self-compact-and-compact-on-idle).

/** F1 poll cadence while waiting for the current turn to finish before draining. */
const deferredCompactionPollMs = 3_000;

interface ThreadCompactionResult {
  ok: boolean;
  error?: string;
  /**
   * The full compaction summary to post into the topic, marker-stripped and ready
   * to send, or `null` when it must not be posted (the setting is off, the backend
   * streams its own, the route never produced one, or it could not be read).
   */
  summary?: string | null;
  /**
   * Context token counts the backend reported for the compaction, `null` when it
   * reports none (see {@link CompactionResult}). Both present ⇒ the completion
   * message names the numbers; otherwise it is the same sentence without them.
   */
  preTokens?: number | null;
  postTokens?: number | null;
}

/**
 * @description Resolve the `/compact` route for a thread's current backend — the
 * pure {@link getCompactCommandRoute} wrapped with the live adapter reading.
 * Every compaction entry point (the command, the seam, the F1 arm + drain, the
 * `/compact_on_idle` gate) asks the same question, so the three-line lookup lives
 * in ONE place rather than being spelled out at each of them.
 */
function getThreadCompactRoute(key: SessionKey): CompactCommandRoute {
  const adapter = getThreadAdapter(key);
  return getCompactCommandRoute({
    hasCompactContext: Boolean(adapter.compactContext),
    adapterName: adapter.name,
    terminalAdapterName,
  });
}

/**
 * Per-thread bookkeeping for the idle watchdog (F2) — the live TIMER only. The
 * three instants the watchdog reasons about (last activity / last turn end / last
 * compaction) live in the state store, which is their single source of truth: they
 * must survive a restart (the bot hot-reloads on every code change), and keeping
 * an in-memory duplicate would only let the two copies drift.
 */
interface ThreadCompactionState {
  idleTimer: NodeJS.Timeout | null;
}

/** The two switches the `/compact_on_idle` picker shows: the idle compaction itself and the summary post. */
interface CompactOnIdlePickerState {
  isIdleEnabled: boolean;
  /** The `/compact_summary` setting — the same one, so the two pickers can never disagree. */
  isSummaryEnabled: boolean;
}

/**
 * Build the `/compact_on_idle` picker keyboard: Enable / Disable, then Show / Hide
 * summary, ✓ on the current value of each.
 */
function buildCompactOnIdleKeyboard(picker: CompactOnIdlePickerState) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t('compactOnIdle.enableButton') + (picker.isIdleEnabled ? ' ✓' : ''), 'coi_on'),
      Markup.button.callback(t('compactOnIdle.disableButton') + (!picker.isIdleEnabled ? ' ✓' : ''), 'coi_off'),
    ],
    [
      Markup.button.callback(t('compactOnIdle.summaryShowButton') + (picker.isSummaryEnabled ? ' ✓' : ''), 'coi_sum_on'),
      Markup.button.callback(t('compactOnIdle.summaryHideButton') + (!picker.isSummaryEnabled ? ' ✓' : ''), 'coi_sum_off'),
    ],
  ]);
}

/**
 * What the compaction flow needs from the bot: the shared core, the typing indicator, the prompt path the
 * compaction instruction goes through, and the pending-question state the idle re-ask reads and clears.
 */
export interface CompactionPorts
  extends Pick<
    BotCore,
    'bot' | 'command' | 'getState' | 'replyToThread' | 'deleteThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral' | 'wakeSleepingSession'
  > {
  startTypingLoader: (key: SessionKey) => void;
  forwardPromptToAgent: (key: SessionKey, adapter: AgentAdapter, text: string) => Promise<void>;
  pendingQuestions: Map<string, PendingQuestionState>;
  clearPendingQuestion: (key: SessionKey) => void;
  /** The idle window in force (`AGENT_IDLE_MINUTES` or the 55-minute default; L-D9). */
  idleWindowMs: number;
  /** Whether a usage-limit wait is armed for the topic — no compaction turn then (L-D6). */
  checkIsLimitWaitArmed: (key: SessionKey) => boolean;
  /**
   * Stop the topic's process, the session kept resumable (the idle stop, L3) — the bot's own orchestration:
   * one transition per key, a prompt arriving meanwhile buffered and the session resumed for it.
   */
  suspendThreadSession: (key: SessionKey) => Promise<void>;
  /** Wake a SLEEPING per-turn session for its idle compaction (L-D7): a resume only; `true` when it is live. */
  resumeSleepingSessionForCompaction: (key: SessionKey) => Promise<boolean>;
}

/**
 * @description Build the compaction flow — `/compact`, the compact-on-idle watchdog and its deferred variant —
 * over its ports. It returns the activity hooks the bot's prompt, output and session-lifecycle paths call, the
 * state the typing loop and the request probe read, and the `register…()` calls.
 */
export function createCompaction(ports: CompactionPorts) {
  const { startTypingLoader, forwardPromptToAgent, pendingQuestions, clearPendingQuestion, idleWindowMs, checkIsLimitWaitArmed, suspendThreadSession, resumeSleepingSessionForCompaction, bot, command, getState, replyToThread, deleteThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral, wakeSleepingSession } = ports;

  /**
   * Threads with a compaction IN FLIGHT (via {@link runThreadCompaction}). While a
   * key is here, the compaction's OWN output (some backends stream the summary
   * turn) must NOT count as thread activity — otherwise it would re-arm the idle
   * watchdog and mark a "completed turn", re-firing compaction on the next idle
   * with no real user activity (a loop). See {@link handleAgentOutput}.
   */
  const threadsCompacting = new Set<string>();

  /**
   * @description Is a bot-issued compaction in flight for `key`? The live reading
   * behind the typing indicator's `isCompacting` input (S3) — both the keep-alive
   * rule and the leak backstop's veto read it, so a compaction shows the native
   * "working" state for its whole duration instead of leaving the topic blank for
   * minutes. Reuses the EXISTING {@link threadsCompacting} set (already maintained
   * as the idle-watchdog loop guard) — no second piece of state to keep in step.
   */
  function checkIsThreadCompacting(key: SessionKey): boolean {
    return threadsCompacting.has(keyToString(key));
  }

  /**
   * @description Shared execution seam for the compaction triggers. Resolves the
   * `/compact` route (same pure decision as the manual command), optionally
   * appends the F2 closing-section instruction, runs the REAL compaction, and reads
   * the generated summary when `/compact_summary` has it posted. Returns the
   * outcome; the CALLER owns any topic message so each trigger words it its own way
   * (the operator-present narration vs the idle notice).
   *
   * Also the ONE place the typing indicator is started for a compaction (S3), so all
   * three triggers get it without each remembering to. It is deliberately NOT stopped
   * in the `finally`: dropping the key from {@link threadsCompacting} makes the
   * existing keep-alive rule self-stop on the loader's next tick, whereas an explicit
   * stop here could kill a loader a CONCURRENT prompt had armed.
   */
  async function runThreadCompaction(
    key: SessionKey,
    opts: { withClosingSection: boolean },
  ): Promise<ThreadCompactionResult> {
    const adapter = getThreadAdapter(key);
    if (!adapter.checkIsActive(key)) return { ok: false, error: t('compact.start_agent_first') };
    const route = getThreadCompactRoute(key);
    if (route === 'notSupported') {
      return { ok: false, error: t('compact.unsupported_backend', { label: adapter.label }) };
    }

    // D3: every bot-issued compaction carries the maximally-complete-summary
    // guidance (baked in the OpenCode fork, appended for the Claude backends), plus
    // the F2 closing-section directive when requested.
    const instruction = await getCompactionInstruction(adapter, key, { withClosingSection: opts.withClosingSection });

    const kStr = keyToString(key);
    threadsCompacting.add(kStr);
    // S3: `threadsCompacting` is set FIRST, so the loader's very first keep-alive
    // check already sees the compaction and cannot self-stop on a topic that is
    // otherwise idle (which is exactly what a compacting OpenCode session looks like).
    if (checkIsTelegramKey(key)) startTypingLoader(key); // a tracker issue has no topic to show typing in (R6)
    try {
      if (route === 'forwardToAgent') {
        // tmux Claude: its TUI parses `/compact [instruction]` natively. Best-effort —
        // there is no completion signal to await, so no closing-section read here.
        const text = instruction ? `${compactCommandText} ${instruction}` : compactCommandText;
        await forwardPromptToAgent(key, adapter, text);
        return { ok: true };
      }

      // adapterCompact: OpenCode / json-stream — a real, awaited compaction.
      // `compactContext` is present on this route by construction (it IS what
      // `getCompactCommandRoute` tested for), but the method is optional on the
      // interface, so the absence is answered rather than non-null-asserted.
      if (!adapter.compactContext) return { ok: false, error: t('compact.unsupported_backend', { label: adapter.label }) };
      const compaction = await adapter.compactContext(key, instruction);
      if (!compaction.ok) return { ok: false, error: compaction.error };

      const isWithSummary = checkShouldPostCompactionSummary({
        isEnabled: getState().checkIsCompactSummaryEnabled(key),
        streamsOwnSummary: Boolean(adapter.streamsCompactionSummary),
        route,
      });
      // A transcript / HTTP read, made only when the summary will be posted.
      const summary = isWithSummary && adapter.getLatestCompactionSummary
        ? await adapter.getLatestCompactionSummary(key).catch(() => null)
        : null;
      return {
        ok: true,
        summary: summary ? stripCompactionClosingMarkers(summary) : null,
        preTokens: compaction.preTokens,
        postTokens: compaction.postTokens,
      };
    } finally {
      threadsCompacting.delete(kStr);
    }
  }

  /**
   * @description Run a bot-issued compaction the operator is PRESENT for — the
   * manual `/compact` command and the agent's `compact_conversation` drain — and
   * narrate it in the topic: the start notice BEFORE the wait, then the completion
   * report (with token counts when the backend gave any).
   *
   * The start notice used to be posted AFTER the wait returned, which read as "it is
   * starting now" when it was already over — and for the 1–3+ minutes in between the
   * topic showed nothing at all. Both triggers share this one body so the two can
   * never narrate a compaction differently.
   *
   * Narration is `adapterCompact`-ONLY. On the `forwardToAgent` route (the tmux
   * Claude backend) the TUI parses `/compact` and renders its own progress, and the
   * bot has no completion signal to await there — announcing "compacted" the instant
   * the text was typed in would be a claim the bot cannot back.
   */
  async function runNarratedCompaction(key: SessionKey, route: CompactCommandRoute, logTag: string): Promise<void> {
    const isNarrated = route === 'adapterCompact';
    // The START notice also needs the session to be live (pure rule): the seam refuses
    // a dead session as its first act, and a "compacting…" ahead of that refusal is a
    // promise the very next message retracts. The seam still re-checks, so a session
    // lost right afterwards just reports the failure as before.
    if (checkShouldAnnounceCompactionStart({ route, isSessionActive: getThreadAdapter(key).checkIsActive(key) })) {
      await replyToThread(key, t('compact.started'));
    }

    // No closing section: the operator is right here, so there is nothing to recap
    // to a future reader of the topic.
    const result = await runThreadCompaction(key, { withClosingSection: false });
    if (!result.ok) {
      console.warn(`[${logTag}] ${keyToString(key)} compaction failed: ${result.error ?? 'unknown'}`);
      // Always surfaced, even on the drain, which used to only log: having just
      // announced a start, going silent would leave the operator waiting on a
      // compaction that already gave up.
      await replyToThread(key, result.error ?? t('compact.failed', { reason: 'unknown' }));
      return;
    }

    // Close the F2 fire guard. Not against an IMMEDIATE re-fire — the `command()`
    // wrapper already re-armed a fresh idle window for this thread — but against the
    // END of that window: without the stamp `lastTurnEndAt` would still be ahead of
    // `lastCompactionAt` there, so the watchdog would compact again with nothing new
    // to compress. Only on SUCCESS: stamping a compaction that never ran would
    // durably close the guard over a still-huge context.
    await getState().setCompactIdleCompactedAt(key);

    if (!isNarrated) return;
    const { preTokens, postTokens } = result;
    await replyToThread(
      key,
      // Both counts or neither: one number alone says nothing about what was saved.
      typeof preTokens === 'number' && typeof postTokens === 'number'
        ? t('compact.done_tokens', { pre: formatTokenCount(preTokens), post: formatTokenCount(postTokens) })
        : t('compact.done'),
    );
    if (result.summary) await postCompactionSummary(key, result.summary);
  }

  /**
   * @description Post a compaction's FULL summary into the topic — the single poster
   * shared by all three triggers, each calling it after its own notice.
   *
   * Sent as PLAIN text with no `parse_mode`: this is freeform model prose, and one
   * stray backtick or asterisk in a Markdown/HTML send makes Telegram reject the
   * whole message, which would lose the summary entirely (§1.5). Long summaries are
   * SPLIT by the existing splitter, never truncated.
   *
   * Deliberately NOT routed through the agent-output path: that path stamps thread
   * activity and would re-arm the idle watchdog off the bot's own message — the loop
   * the `threadsCompacting` guard exists to prevent.
   */
  async function postCompactionSummary(key: SessionKey, summary: string): Promise<void> {
    const chunks = splitMessage(`${t('compact.summaryHeader')}\n\n${summary}`, MAX_MESSAGE_LEN);
    for (const chunk of chunks) await replyToThread(key, chunk);
  }

  const threadCompactionStates = new Map<string, ThreadCompactionState>();

  function getThreadCompactionState(kStr: string): ThreadCompactionState {
    let existing = threadCompactionStates.get(kStr);
    if (!existing) {
      existing = { idleTimer: null };
      threadCompactionStates.set(kStr, existing);
    }
    return existing;
  }

  /** F1: threads whose agent asked (via the MCP tool) to compact when the turn ends. */
  const deferredCompactionArmed = new Set<string>();
  const deferredCompactionPollTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Human wording for the arm-kind the idle decision reports, for the diagnostic log
   * only (log text, so it stays out of `i18n.ts` — never user-facing).
   */
  const idleArmKindLabels: Record<IdleCompactionArmKind, string> = {
    fullWindow: 'full window',
    remainder: 'remainder',
    overdue: 'overdue (staggered)',
  };

  /**
   * @description Re-arm the F2 idle timer for a thread on REAL activity (a user
   * message / command, a forwarded prompt, or agent output). Stamps the persisted
   * activity instant, so the countdown restarts from NOW — that is what makes this
   * different from {@link rearmThreadIdleTimer}, which must not move the stamp. The
   * feature's OWN notice is sent via `replyToThread`, which does NOT call this, so
   * the notice cannot re-arm the watchdog into a loop.
   */
  function noteThreadActivity(key: SessionKey): void {
    armThreadIdleTimer(key, { isRealActivity: true });
  }

  /**
   * @description Re-arm the F2 idle timer for a session the bot just RE-ADOPTED
   * after a restart. A restart is not activity in the topic, so this deliberately
   * does NOT stamp the activity instant: the timer is armed from the PERSISTED one,
   * i.e. on the REMAINDER of the 55-minute window (or a staggered short delay when
   * the thread is already overdue). Arming the full window here — what the reattach
   * used to do by calling {@link noteThreadActivity} — meant that a bot restarting
   * more often than every 55 minutes (normal in hot-reload development) never let
   * any topic reach the threshold.
   */
  function rearmThreadIdleTimer(key: SessionKey): void {
    armThreadIdleTimer(key, { isRealActivity: false });
  }

  /**
   * Shared arming core behind {@link noteThreadActivity} and
   * {@link rearmThreadIdleTimer} — one body so the two entry points can only differ
   * in whether they count as activity. Arms when an agent session is active and no
   * compaction is in flight. On a backend that is STOPPED at the idle mark
   * (`suspendSession`, L3) the timer is armed regardless of the compaction toggle
   * and the user-latch: the stop happens either way (L-D1), and the fire decides
   * the compaction. On any other backend the timer exists for the compaction
   * alone, so it is armed only when the feature is enabled for the thread AND the
   * user-latch is NOT spent (D2): once an idle-compaction has fired this
   * user-active period the thread stays latched — agent output resets nothing, and
   * only a genuine USER message (via {@link noteThreadUserActivity}) clears the
   * latch. That latch, being persisted, is also what stops a restart from
   * re-firing.
   */
  function armThreadIdleTimer(key: SessionKey, opts: { isRealActivity: boolean }): void {
    const kStr = keyToString(key);
    // A compaction in flight is NOT user/turn activity — skip so the compaction's
    // own streamed summary (some backends) can't re-arm the watchdog into a loop.
    if (threadsCompacting.has(kStr)) return;
    const compactionState = getThreadCompactionState(kStr);
    if (compactionState.idleTimer) {
      clearTimeout(compactionState.idleTimer);
      compactionState.idleTimer = null;
    }
    const adapter = getThreadAdapter(key);
    const isSuspendable = typeof adapter.suspendSession === 'function';
    if (!isSuspendable && !getState().checkIsCompactOnIdleEnabled(key)) return;
    // L-D7: a SLEEPING per-turn session keeps its countdown while a compaction is due — the fire wakes it,
    // compacts it, and stops it again; every other sleeping or idle-less session has no timer.
    if (!adapter.checkIsActive(key) && !(adapter.name === claudePerTurnAdapterName && checkIsCompactionDue(key))) return;
    const now = Date.now();
    // Stamp AFTER the enabled/active guards (a disabled or session-less topic has no
    // countdown to measure) but BEFORE the latch guard: a latched thread still has
    // activity worth recording — the latch only suppresses the TIMER.
    if (opts.isRealActivity) getState().noteCompactIdleActivity(key, now);
    // D2: a spent latch means idle-compaction already fired this user-active period
    // — do NOT re-arm until a genuine USER message clears the latch.
    if (!isSuspendable && getState().checkIsCompactIdleLatched(key)) return;
    const { lastActivityAt } = getState().getCompactIdleTracking(key);
    const { delayMs, kind } = getIdleCompactionArmDecision({ threadKeyString: kStr, lastActivityAt, now, idleWindowMs });
    if (!opts.isRealActivity) {
      // Session-start / re-adopt only (once per thread per boot, or per manual start) —
      // was the other blind spot: nothing showed whether an adopted thread got re-armed
      // and for how long. Deliberately NOT logged for real activity, which runs on
      // every output chunk and would flood. The kind is the one the decision REPORTED —
      // re-deriving it here would let the log name a case the timer is not in.
      console.log(`[compact-on-idle] ${kStr} armed on session start: ${idleArmKindLabels[kind]}, ${(delayMs / 60_000).toFixed(1)} min`);
    }
    const timer = setTimeout(() => {
      compactionState.idleTimer = null;
      void withThreadLocale(key, () => onIdleCompactionTimerFired(key));
    }, delayMs);
    timer.unref?.();
    compactionState.idleTimer = timer;
  }

  /**
   * @description A genuine USER message (text / voice / file) or a fresh session
   * start (D2): clear the spent idle-compaction latch so the next idle period can
   * compact again, THEN reset/arm the idle timer. Distinct from
   * {@link noteThreadActivity} — which agent output and bot-initiated forwards also
   * call — because those must NEVER re-arm the latch, only a real user does.
   */
  function noteThreadUserActivity(key: SessionKey): void {
    if (getState().checkIsCompactIdleLatched(key)) {
      void getState().setCompactIdleLatched(key, false);
    }
    noteThreadActivity(key);
  }

  /**
   * Mark that an agent turn produced output — there is now something to compress.
   * PERSISTED: the fire guard compares this against the last compaction, and after a
   * restart an in-memory-only stamp read back as 0, which read as "nothing to
   * compress" and silently disabled the feature in every quiet topic.
   */
  function markThreadTurnProducedOutput(key: SessionKey): void {
    const kStr = keyToString(key);
    if (threadsCompacting.has(kStr)) return; // the compaction's own output isn't a turn
    getState().noteCompactIdleTurnEnd(key);
  }

  /** Whether the agent's `compact_conversation` armed a compaction for when the turn ends (F1). */
  function checkIsDeferredCompactionArmed(key: SessionKey): boolean {
    return deferredCompactionArmed.has(keyToString(key));
  }

  /** Clear all compaction timers/arms for a thread (session teardown / unbind). */
  function clearThreadCompaction(key: SessionKey): void {
    const kStr = keyToString(key);
    const compactionState = threadCompactionStates.get(kStr);
    if (compactionState?.idleTimer) clearTimeout(compactionState.idleTimer);
    threadCompactionStates.delete(kStr);
    // Drop the persisted instants too, so the NEXT session in this topic starts with
    // no history and therefore gets the FULL idle window — which is why the fresh-start
    // path needs no special case (do not "fix" it by adding one).
    void getState().clearCompactIdleTracking(key);
    deferredCompactionArmed.delete(kStr);
    const pollTimer = deferredCompactionPollTimers.get(kStr);
    if (pollTimer) clearTimeout(pollTimer);
    deferredCompactionPollTimers.delete(kStr);
    reAskedQuestionOptions.delete(kStr);
  }

  /**
   * @description Whether the topic's process is WORKING right now (L-D2). The
   * turn and the background work are read APART: a pending interactive question
   * makes the session report busy, but it is idle-WAITING, not running a turn —
   * D1 treats that as a FIRE condition (reject + compact + re-ask), so the
   * question excuses the turn alone. It never excuses a background task, input
   * not yet taken in or a compaction in flight: with those the process is working
   * whatever the question says, and is neither compacted nor stopped.
   */
  function checkIsThreadWorking(key: SessionKey, adapter: AgentAdapter): boolean {
    return checkIsWorkingAtIdle({
      isBusy: adapter.checkIsBusy?.(key) ?? false,
      hasPendingQuestion: pendingQuestions.has(keyToString(key)),
      hasBackgroundWork: adapter.checkHasBackgroundWork?.(key) ?? false,
    });
  }

  /**
   * @description The idle timer fired (F2 + lifecycle plan L3): nothing while the
   * process works; else compact once when the guard allows (D1/D2, L-D6), then — on
   * a backend that can be suspended — stop the process, the session kept resumable
   * (L-D1: whether or not the compaction ran). The stop re-checks "working" after
   * the compaction: a prompt taken in meanwhile keeps the process.
   */
  /** Whether the idle compaction has something to do for the topic: enabled, not latched (D2), a turn since the last compaction. */
  function checkIsCompactionDue(key: SessionKey): boolean {
    if (!getState().checkIsCompactOnIdleEnabled(key) || getState().checkIsCompactIdleLatched(key)) return false;
    const { lastTurnEndAt, lastCompactionAt } = getState().getCompactIdleTracking(key);
    return lastTurnEndAt > lastCompactionAt;
  }

  async function onIdleCompactionTimerFired(key: SessionKey): Promise<void> {
    const kStr = keyToString(key);
    const adapter = getThreadAdapter(key);
    // L-D7: a sleeping per-turn session is resumed for its compaction; the stop below puts it back to sleep.
    if (!adapter.checkIsActive(key) && adapter.name === claudePerTurnAdapterName && checkIsCompactionDue(key)) {
      if (!(await resumeSleepingSessionForCompaction(key))) {
        console.log(`[compact-on-idle] ${kStr} sleeping per-turn session could not be resumed for its compaction`);
        return;
      }
      console.log(`[compact-on-idle] ${kStr} sleeping per-turn session resumed for its compaction`);
    }
    // Both instants come from the store, so a restart no longer erases the evidence
    // that this session has an un-compacted turn (the bug: two in-memory zeros made
    // `0 > 0` false, and D2's no-reschedule rule then left the feature dead).
    const { lastTurnEndAt, lastCompactionAt } = getState().getCompactIdleTracking(key);
    const decision = getIdleFireDecision({
      isSessionActive: adapter.checkIsActive(key),
      isWorking: checkIsThreadWorking(key, adapter),
      isEnabled: getState().checkIsCompactOnIdleEnabled(key),
      isLatched: getState().checkIsCompactIdleLatched(key),
      hasCompletedTurnSinceCompaction: lastTurnEndAt > lastCompactionAt,
      isLimitWaitArmed: checkIsLimitWaitArmed(key),
      canSuspend: typeof adapter.suspendSession === 'function',
    });
    if (decision.shouldCompact) {
      await runIdleCompaction(key, adapter);
    } else {
      // Log WHICH condition blocked it: this branch was the feature's blind spot —
      // it returned silently, which is why nothing in any log showed the watchdog
      // was even trying. At most once per armed timer, so it cannot flood.
      console.log(`[compact-on-idle] ${kStr} timer fired but the compaction is skipped: ${decision.compactionSkipReasons.join(', ')}`);
    }
    if (!decision.shouldSuspend) {
      // D2: no reschedule. A real running turn will emit output that resets the
      // timer via `noteThreadActivity`; every other miss re-arms only on the next
      // genuine USER message (which clears the latch).
      console.log(`[compact-on-idle] ${kStr} process kept: ${decision.suspendSkipReasons.join(', ')}`);
      return;
    }
    // A per-turn session is stopped by its own `turnEnded` as the compaction turn ends (L5): nothing left to stop.
    if (!adapter.checkIsActive(key)) {
      console.log(`[compact-on-idle] ${kStr} process already stopped during the idle fire`);
      return;
    }
    if (checkIsThreadWorking(key, adapter)) {
      console.log(`[compact-on-idle] ${kStr} process kept: it started working during the idle fire`);
      return;
    }
    await suspendThreadSession(key);
  }

  /** The idle compaction itself (D1/D2): latch, stamp, re-ask a pending question after it, post the outcome. */
  async function runIdleCompaction(key: SessionKey, adapter: AgentAdapter): Promise<void> {
    const kStr = keyToString(key);
    const hasPendingQuestion = pendingQuestions.has(kStr);

    // D2: latch the thread the instant the fire is decided (BEFORE any output) and
    // persist it, so a bot restart can't re-fire and no second compaction runs this
    // user-active period. Stamp `lastCompactionAt` too so the re-fire guard holds
    // even if the compaction itself runs long.
    void getState().setCompactIdleLatched(key, true);
    // Awaited (unlike the latch): the stamp must be in place BEFORE the compaction
    // starts, since it is what closes the "has an un-compacted turn" guard.
    await getState().setCompactIdleCompactedAt(key);

    // D1: a pending question at idle → reject it server-side to UNBLOCK the turn
    // (reusing each backend's abort-error swallow via rejectQuestion + SIGINT),
    // remember it, drop the bot-side pending state + its now-stale buttons, then
    // RE-ASK it after the compaction with real buttons that feed a fresh prompt.
    let savedQuestion: PendingQuestionState | null = null;
    if (hasPendingQuestion) {
      savedQuestion = pendingQuestions.get(kStr) ?? null;
      const staleQuestionMessageId = savedQuestion?.messageId ?? null;
      adapter.rejectQuestion?.(key);
      adapter.sendSignal(key, 'SIGINT');
      clearPendingQuestion(key);
      if (staleQuestionMessageId !== null) {
        await deleteThreadMessage(key, staleQuestionMessageId).catch(() => {});
      }
    }

    const result = await runThreadCompaction(key, { withClosingSection: true });
    if (!result.ok) {
      console.warn(`[compact-on-idle] ${kStr} compaction failed: ${result.error ?? 'unknown'}`);
      // The compaction failed but the question is already rejected — re-ask it so
      // the user isn't left without the pending decision (no notice: nothing was
      // compacted).
      await postIdleCompactionResult(key, { noticeText: null, summary: null }, savedQuestion);
      return;
    }
    await postIdleCompactionResult(
      key,
      {
        noticeText: t('compactOnIdle.notice'),
        summary: result.summary ?? null,
      },
      savedQuestion,
    );
  }

  /**
   * @description Per-thread option labels of an idle-compaction RE-ASKED question
   * (D1), keyed by {@link SessionKey} string. A `reask_<idx>` tap forwards the
   * matching label to the (now compacted) session as a FRESH prompt — the original
   * question request was rejected server-side, so it cannot be answered any more.
   * In-memory only: after a restart the buttons are simply inert ("no pending
   * question"), which is safe.
   */
  const reAskedQuestionOptions = new Map<string, string[]>();

  /**
   * @description Build the RE-ASK inline keyboard for an idle-compaction pending
   * question (D1) and record its option labels so a `reask_<idx>` tap can forward
   * the chosen label as a fresh prompt.
   */
  function buildReAskKeyboard(
    key: SessionKey,
    question: OpenCodeQuestion,
  ): InlineKeyboardMarkup | undefined {
    reAskedQuestionOptions.set(keyToString(key), question.options.map((opt) => opt.label));
    return buildQuestionOptionsKeyboard(question, (optionIndex) => `reask_${optionIndex}`);
  }

  /**
   * @description Post the idle-compaction outcome (D1/D2) as SEPARATE messages in
   * the §1.4 order: the short notice → the full summary (when `/compact_summary` is
   * on) → the RE-ASKED question with its option buttons, LAST.
   *
   * The three used to be one joined message. They are split because the re-asked
   * question carries inline buttons the operator must be able to reach: glued behind
   * a full summary they end up buried under a wall of text, and a long summary does
   * not fit one Telegram message at all. The ORDER is what keeps the buttons the last
   * thing in the topic.
   *
   * `parts.noticeText` is `null` on a compaction failure (re-ask only, no notice).
   * No-op when there is nothing at all to say.
   */
  async function postIdleCompactionResult(
    key: SessionKey,
    parts: { noticeText: string | null; summary: string | null },
    savedQuestion: PendingQuestionState | null,
  ): Promise<void> {
    const question = savedQuestion?.data.questions[savedQuestion.currentIndex];
    const questionText = question
      ? [
          t('compactOnIdle.pendingQuestionReask'),
          question.header ? `${question.header}\n${question.question}` : question.question,
        ].join('\n\n')
      : null;

    // A tracker issue has no topic to narrate into (R6): the compaction and the stop stay silent there.
    if (!checkIsTelegramKey(key)) return;
    const plan = buildIdleCompactionNoticeParts({ ...parts, questionText });
    if (plan.notice) await replyToThread(key, plan.notice);
    if (plan.summary) await postCompactionSummary(key, plan.summary);
    // The keyboard is built HERE (not while planning): it also records the option
    // labels a `reask_<idx>` tap resolves against, which must not happen for a
    // question that is never posted.
    if (plan.question && question) await replyToThread(key, plan.question, buildKeyboardExtra(buildReAskKeyboard(key, question)));
  }

  /**
   * @description F1: arm a "compact when the current turn finishes" request from
   * the agent's `compact_conversation` MCP tool. Returns a short status the tool
   * relays to the agent. Refuses when there is no active agent session (nothing to
   * compact). The drain (below) runs the plain compaction once the session idles.
   */
  function armDeferredCompaction(key: SessionKey): { ok: boolean; message: string } {
    const adapter = getThreadAdapter(key);
    if (!adapter.checkIsActive(key)) {
      return { ok: false, message: 'No active agent session in this topic — nothing to compact.' };
    }
    if (getThreadCompactRoute(key) === 'notSupported') {
      return { ok: false, message: 'This session type cannot be compacted.' };
    }
    deferredCompactionArmed.add(keyToString(key));
    scheduleDeferredCompactionPoll(key);
    return { ok: true, message: 'Compaction is armed — it will run automatically when this turn finishes.' };
  }

  function scheduleDeferredCompactionPoll(key: SessionKey): void {
    const kStr = keyToString(key);
    if (!deferredCompactionArmed.has(kStr)) return;
    if (deferredCompactionPollTimers.has(kStr)) return; // already polling
    const timer = setTimeout(() => {
      deferredCompactionPollTimers.delete(kStr);
      void withThreadLocale(key, () => tickDeferredCompaction(key));
    }, deferredCompactionPollMs);
    timer.unref?.();
    deferredCompactionPollTimers.set(kStr, timer);
  }

  async function tickDeferredCompaction(key: SessionKey): Promise<void> {
    const kStr = keyToString(key);
    if (!deferredCompactionArmed.has(kStr)) return;
    const adapter = getThreadAdapter(key);
    if (!adapter.checkIsActive(key)) {
      deferredCompactionArmed.delete(kStr);
      return;
    }
    if (adapter.checkIsBusy?.(key)) {
      scheduleDeferredCompactionPoll(key); // still mid-turn — keep waiting
      return;
    }
    deferredCompactionArmed.delete(kStr);
    // §1.3: the agent only calls `compact_conversation` because the operator asked
    // it to, so the operator IS present and waiting — this compaction is narrated
    // exactly like the manual one (it used to post nothing at all). The shared body
    // also owns the `lastCompactionAt` stamp that keeps F2 from re-firing on top of
    // it, in this process or after a restart.
    await runNarratedCompaction(key, getThreadCompactRoute(key), 'compact-tool');
  }

  /**
   * @description Shared core of the `/compact_on_idle` command + its inline
   * callback. Regular topic → the per-thread override; General topic → the
   * instance-wide default. Applies the toggle, confirms, and re-arms/disarms the
   * idle watchdog for a regular topic.
   */
  async function applyCompactOnIdle(key: SessionKey, isGeneral: boolean, enabled: boolean): Promise<void> {
    const stateWord = enabled ? t('compactOnIdle.on') : t('compactOnIdle.off');
    if (isGeneral) {
      await getState().setCompactOnIdleGlobalDefault(enabled);
      await replyToThread(key, t('compactOnIdle.setGlobal', { state: stateWord }));
      return;
    }
    await getState().setCompactOnIdleOverride(key, enabled);
    await replyToThread(key, t('compactOnIdle.setThisTopic', { state: stateWord }));
    if (enabled) noteThreadActivity(key);
    else {
      const compactionState = threadCompactionStates.get(keyToString(key));
      if (compactionState?.idleTimer) {
        clearTimeout(compactionState.idleTimer);
        compactionState.idleTimer = null;
      }
    }
  }

  /**
   * @description Both switches as the `/compact_on_idle` picker shows them: in General
   * the instance-wide defaults, in a regular topic what applies to that topic.
   */
  function getCompactOnIdlePickerState(key: SessionKey, isGeneral: boolean): CompactOnIdlePickerState {
    return isGeneral
      ? { isIdleEnabled: getState().getCompactOnIdleGlobalDefault(), isSummaryEnabled: getState().getCompactSummaryGlobalDefault() }
      : { isIdleEnabled: getState().checkIsCompactOnIdleEnabled(key), isSummaryEnabled: getState().checkIsCompactSummaryEnabled(key) };
  }

  /**
   * @description A tap on the `/compact_on_idle` picker — either row. `apply` writes
   * the setting and posts its confirmation; the keyboard is then re-rendered from the
   * stored state so the ✓ of BOTH rows is right.
   */
  async function handleCompactOnIdleCallback(
    ctx: Context,
    apply: (key: SessionKey, isGeneral: boolean) => Promise<void>,
  ): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    const isGeneral = checkIsGeneral(key);
    await withThreadLocale(key, () => apply(key, isGeneral));
    await ctx.answerCbQuery();
    // Re-render the picker keyboard so the ✓ follows the new state.
    const cbMsg = ctx.callbackQuery?.message as Message | undefined;
    if (cbMsg) {
      const keyboard = withThreadLocale(key, () => buildCompactOnIdleKeyboard(getCompactOnIdlePickerState(key, isGeneral)));
      try {
        await enqueueSend(
          key,
          () => bot.telegram.editMessageReplyMarkup(getTelegramChatId(key), cbMsg.message_id, undefined, keyboard.reply_markup),
        );
      } catch (e) {
        const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
        if (!/message is not modified/i.test(desc)) console.warn('[coi_cb] keyboard re-render failed:', desc || e);
      }
    }
  }

  /**
   * @description Apply the `/compact_summary` setting and RETURN the confirmation
   * text — the single write path behind the command, its picker buttons and the
   * summary row of the `/compact_on_idle` picker, so they can never drift. Regular topic → the per-thread override; General topic →
   * the instance-wide default.
   *
   * Nothing to arm or cancel afterwards (unlike `/compact_on_idle`, which owns a
   * timer): the toggle is read at the moment a compaction finishes.
   */
  async function applyCompactSummary(key: SessionKey, isGeneral: boolean, enabled: boolean): Promise<string> {
    const stateWord = enabled ? t('compactSummary.on') : t('compactSummary.off');
    if (isGeneral) {
      await getState().setCompactSummaryGlobalDefault(enabled);
      return t('compactSummary.setGlobal', { state: stateWord });
    }
    await getState().setCompactSummaryOverride(key, enabled);
    return t('compactSummary.setThisTopic', { state: stateWord });
  }

  /** Build the `/compact_summary` picker keyboard (Enable / Disable, ✓ on current). */
  function buildCompactSummaryKeyboard(isEnabled: boolean) {
    return Markup.inlineKeyboard([
      Markup.button.callback(t('compactSummary.enableButton') + (isEnabled ? ' ✓' : ''), 'csum_on'),
      Markup.button.callback(t('compactSummary.disableButton') + (!isEnabled ? ' ✓' : ''), 'csum_off'),
    ]);
  }

  /**
   * @description `/compact_summary` picker button. A REPEATED-USE picker, so it
   * re-renders its keyboard in place (the ✓ follows the new state) rather than being
   * consumed into a keyboard-less confirmation — mirrors `coi_on`/`coi_off`.
   */
  async function handleCompactSummaryCallback(ctx: Context, enabled: boolean): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    const isGeneral = checkIsGeneral(key);
    await withThreadLocale(key, async () => {
      await replyToThread(key, await applyCompactSummary(key, isGeneral, enabled));
    });
    await ctx.answerCbQuery();
    const cbMsg = ctx.callbackQuery?.message as Message | undefined;
    if (cbMsg) {
      const keyboard = buildCompactSummaryKeyboard(enabled);
      try {
        await enqueueSend(
          key,
          () => bot.telegram.editMessageReplyMarkup(getTelegramChatId(key), cbMsg.message_id, undefined, keyboard.reply_markup),
        );
      } catch (e) {
        const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
        if (!/message is not modified/i.test(desc)) console.warn('[csum_cb] keyboard re-render failed:', desc || e);
      }
    }
  }

  function registerCompactionCommands(): void {
    // `/compact` — shrink the agent's context. BOT-OWNED, because "forward the text
    // and hope" only works for a backend that parses slash commands itself: OpenCode's
    // prompt transport does not, so the literal `/compact` used to reach the model as
    // an ordinary prompt and burn a whole turn without compacting anything. The
    // three-way decision is the pure `getCompactCommandRoute`.
    command('compact', async (_ctx, key) => {
      const route = getThreadCompactRoute(key);

      // A raw shell has no context to compact — and typing `/compact` into it would
      // just run a meaningless command. Answered from the route HERE rather than from
      // the seam's own `notSupported` result, because the seam checks session liveness
      // first: a terminal topic with no live shell would otherwise be told to start an
      // agent instead of that the backend cannot be compacted.
      if (route === 'notSupported') {
        await replyToThread(key, t('compact.unsupported_backend', { label: getThreadAdapter(key).label }));
        return;
      }

      // A sleeping conversation is woken first (L-D4): the compaction runs on its own context.
      const wakeNotice = await wakeSleepingSession(key);
      if (wakeNotice) await replyToThread(key, wakeNotice);

      // EXECUTION goes through the shared seam (which also carries the D3 summary
      // guidance). Dispatching inline here instead was a real defect: only
      // `runThreadCompaction` adds the thread to `threadsCompacting`, so the summary the
      // manual compaction produced counted as a TURN, pushing `lastTurnEndAt` back ahead
      // of the compaction stamp — and one idle window later the watchdog compacted an
      // already-compacted context.
      await runNarratedCompaction(key, route, 'compact');
    });

    // `/compact_on_idle` — toggle auto-compaction after ~55 min idle. Regular topic
    // → per-thread override; General → the instance-wide default. Bare → a picker:
    // Enable/Disable, plus a Show/Hide row for the `/compact_summary` setting, which
    // is what decides whether an idle compaction ends in one line or with the whole
    // summary (✓ on current). Only meaningful for an agent topic with an active
    // session (terminal / unbound → the "nothing to compact" reply).
    command('compact_on_idle', async (_ctx, key, parsed) => {
      const arg = parsed.args.join(' ').toLowerCase();
      const isGeneral = checkIsGeneral(key);

      if (!isGeneral) {
        if (!getThreadAdapter(key).checkIsActive(key) || getThreadCompactRoute(key) === 'notSupported') {
          await replyToThread(key, t('compactOnIdle.unsupported'));
          return;
        }
      }

      if (arg === 'on' || arg === 'off') {
        await applyCompactOnIdle(key, isGeneral, arg === 'on');
        return;
      }

      const picker = getCompactOnIdlePickerState(key, isGeneral);
      const vars = {
        state: picker.isIdleEnabled ? t('compactOnIdle.on') : t('compactOnIdle.off'),
        summaryLine: t('compactOnIdle.summaryLine', {
          state: picker.isSummaryEnabled ? t('compactSummary.on') : t('compactSummary.off'),
        }),
      };
      const title = isGeneral ? t('compactOnIdle.titleGeneral', vars) : t('compactOnIdle.title', vars);
      await replyToThread(key, title, buildCompactOnIdleKeyboard(picker));
    });

    // `/compact_summary` — toggle writing the agent's FULL compaction summary into the
    // topic. Regular topic → per-thread override; General → the instance-wide default.
    // Bare → an Enable/Disable picker (✓ on current). Deliberately NOT gated on an
    // active session (unlike `/compact_on_idle`, which arms a timer): this one is read
    // when a compaction finishes, so setting it in a quiet or not-yet-started topic is
    // meaningful. Only a raw shell is refused — it has no context to compact.
    command('compact_summary', async (_ctx, key, parsed) => {
      const arg = parsed.args.join(' ').toLowerCase();
      const isGeneral = checkIsGeneral(key);

      if (!isGeneral && getThreadCompactRoute(key) === 'notSupported') {
        await replyToThread(key, t('compactSummary.unsupported'));
        return;
      }

      if (arg === 'on' || arg === 'off') {
        await replyToThread(key, await applyCompactSummary(key, isGeneral, arg === 'on'));
        return;
      }

      const isEnabled = isGeneral
        ? getState().getCompactSummaryGlobalDefault()
        : getState().checkIsCompactSummaryEnabled(key);
      const stateWord = isEnabled ? t('compactSummary.on') : t('compactSummary.off');
      const title = isGeneral
        ? t('compactSummary.titleGeneral', { state: stateWord })
        : t('compactSummary.title', { state: stateWord });
      await replyToThread(key, title, buildCompactSummaryKeyboard(isEnabled));
    });
  }

  function registerCompactionCallbacks(): void {
    bot.action('coi_on', (ctx) => handleCompactOnIdleCallback(ctx, (key, isGeneral) => applyCompactOnIdle(key, isGeneral, true)));

    bot.action('coi_off', (ctx) => handleCompactOnIdleCallback(ctx, (key, isGeneral) => applyCompactOnIdle(key, isGeneral, false)));

    bot.action('coi_sum_on', (ctx) => handleCompactOnIdleCallback(ctx, async (key, isGeneral) => {
      await replyToThread(key, await applyCompactSummary(key, isGeneral, true));
    }));

    bot.action('coi_sum_off', (ctx) => handleCompactOnIdleCallback(ctx, async (key, isGeneral) => {
      await replyToThread(key, await applyCompactSummary(key, isGeneral, false));
    }));

    bot.action('csum_on', (ctx) => handleCompactSummaryCallback(ctx, true));

    bot.action('csum_off', (ctx) => handleCompactSummaryCallback(ctx, false));
  }

  return {
    checkIsThreadCompacting,
    noteThreadActivity,
    noteThreadUserActivity,
    markThreadTurnProducedOutput,
    clearThreadCompaction,
    rearmThreadIdleTimer,
    armDeferredCompaction,
    checkIsDeferredCompactionArmed,
    threadsCompacting,
    reAskedQuestionOptions,
    registerCompactionCommands,
    registerCompactionCallbacks,
  };
}
