import { Markup, type Context } from 'telegraf';
// Decides whether the D3 summary guidance rides the compaction instruction: OpenCode bakes it into its fork
// compaction prompt (covering auto/overflow compaction too), the Claude backends need it every time.
import { claudePerTurnAdapterName, openCodeAdapterName } from '../../../adapters/adapterNames';
import type { AgentAdapter, PendingQuestionState, OpenCodeQuestion, ReAskedQuestionRecord } from '../../../types';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { checkIsTelegramKey } from '../sessionKeyCodec';
import { t } from '../../../i18n';
import { type CompactCommandRoute, getCompactCommandRoute } from '../../../utils/compactCommandRoute';
import {
  buildCompactionInstruction,
  compactionSummaryGuidance,
  compactionResumeGuidance,
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
  checkIsBusyForRealTurn,
  getIdleFireDecision,
  getPendingWorkRecheckDelayMs,
} from '../../../utils/compactOnIdle';
import { buildQuestionOptionsKeyboard, buildKeyboardExtra } from '../questionKeyboards';
import { splitMessage, MAX_MESSAGE_LEN } from '../messageSplit';
import type { BotCore } from './botCore';
import { getQuestionReplyRoute, type QuestionEnd } from '../../../openCodeQuestionFlow';
import type { LatePromptOutcome } from '../../../utils/promptDelivery';
import { getCallbackMessageId, getCallbackMessageText } from './callbackMessage';
import { answerCallbackWithFittedText } from './callbackToast';

/** The literal slash command forwarded to backends whose own CLI parses it. */
const compactCommandText = '/compact';

/** `adapter.name` of the raw-shell backend (see the `terminal` adapter). */
const terminalAdapterName = 'terminal';


/**
 * @description Compose the per-invocation compaction instruction for a thread's
 * backend (D3 summary guidance + the resume guidance — loaded skills and the
 * next-steps checklist — + the optional F2 closing section). The general guidance
 * is skipped for OpenCode (baked in its fork prompt) and appended for the Claude
 * backends; the resume guidance is skipped when the backend's own compaction
 * prompt already gets it (an OpenCode server running the bot's compaction
 * plugin); the closing-section directive rides only when requested.
 */
async function getCompactionInstruction(
  adapter: AgentAdapter,
  key: SessionKey,
  opts: { withClosingSection: boolean },
): Promise<string | undefined> {
  return buildCompactionInstruction({
    bakesSummaryGuidance: adapter.name === openCodeAdapterName,
    summaryGuidance: compactionSummaryGuidance,
    bakesResumeGuidance: (await adapter.checkHasCompactionResumeHook?.(key)) ?? false,
    resumeGuidance: compactionResumeGuidance,
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
 * Per-thread bookkeeping for the idle watchdog (F2) — the live TIMER only. The
 * three instants the watchdog reasons about (last activity / last turn end / last
 * compaction) live in the state store, which is their single source of truth: they
 * must survive a restart (the bot hot-reloads on every code change), and keeping
 * an in-memory duplicate would only let the two copies drift.
 */
interface ThreadCompactionState {
  idleTimer: NodeJS.Timeout | null;
}

/**
 * @description The question the idle compaction asks again (D1), from the moment the compaction starts to the moment the
 * re-ask is used or closed. It goes through three phases, and the one record serves them all:
 *  - COMPACTING — the question was cleared and its old message lost its buttons; nothing is posted yet (`messageId: null`);
 *  - SENDING — the re-ask is being sent: its message exists, the bot has no id for it yet (`messageId: null`);
 *  - POSTED — the re-ask's message is known (`messageId`), its `reask_<i>` buttons live.
 * `predecessorMessageId` is the message the question waited in before: the re-ask is always newer than it, and until the
 * re-ask is posted the predecessor is where the question's result is written. `ending` is set when the record leaves the map
 * as closed or answered — a re-ask that lands later ends the same way.
 */
export interface ReAskedQuestion {
  question: OpenCodeQuestion;
  messageId: number | null;
  predecessorMessageId: number | null;
  /** Whether the predecessor's result («asked again below», or the ending) is written or on its way — nothing else writes it. */
  isPredecessorClosed: boolean;
  /** Whether the edit that gave the predecessor its result has LANDED: what the saved state says, so a restart finishes a lost edit. */
  isPredecessorEditLanded: boolean;
  ending: QuestionEnd | null;
  /** Where the re-ask's own send is: not begun, in flight (the message exists, its id is not known), or over (landed, or failed). */
  sendPhase: 'notStarted' | 'inFlight' | 'finished';
  /** Whether the idle fire has decided about the re-ask (posted it, or found the record taken and left it): its result has run. */
  hasIdleResultRun: boolean;
  /**
   * A typed number answered the question and its label is still on its way to the agent. The record is out of the map, but no
   * result is written on its messages until the delivery is known (it may reach no session, and then the question is open
   * again): a re-ask that lands meanwhile is left as it is, and the idle compaction leaves the predecessor alone.
   */
  isAnswerPending: boolean;
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
    'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadKeyboard' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral' | 'wakeSleepingSession'
  > {
  startTypingLoader: (key: SessionKey) => void;
  forwardPromptToAgent: (key: SessionKey, adapter: AgentAdapter, text: string) => Promise<void>;
  pendingQuestions: Map<string, PendingQuestionState>;
  /** Clear the topic's pending question and unpin it; its message is left as it is (the idle re-ask closes it once the re-ask is posted). */
  clearPendingQuestion: (key: SessionKey) => void;
  /**
   * Edit a question's message to the question as asked plus a note in place of its buttons (the text stays, the message
   * is never deleted); resolves whether it was edited. The re-asked copy uses it with `unanswered` when its conversation ends.
   */
  closeQuestionMessage: (key: SessionKey, messageId: number, question: OpenCodeQuestion, ending: QuestionEnd) => Promise<boolean>;
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
  /** The adapter that runs the topic's conversation (the one a topic with no pick of its own answers to). */
  getThreadAdapter: (key: SessionKey) => AgentAdapter;
  /**
   * Hand the label of an option a person chose on a re-asked question to the conversation as a fresh prompt, routed the way
   * a typed message is (a live session gets it, a stopping one buffers it, a sleeping one is woken). Resolves where it went:
   * `noSession` — nowhere, and the topic was told why.
   */
  deliverLabel: (key: SessionKey, label: string) => Promise<LatePromptOutcome | null>;
  /** Wake the topic's SLEEPING conversation for a prompt of its own; `true` when it is live (a start that failed has told the topic why). */
  resumeSleepingSessionForPrompt: (key: SessionKey) => Promise<boolean>;
  /** Whether a session of the topic is starting (or stopping), so a prompt is buffered for the one to come. */
  checkIsStarting: (key: SessionKey) => boolean;
  /**
   * End a question message the bot holds no record of, when its buttons are tapped: its own text (`messageText`) stays and
   * «not answered» takes the place of the buttons.
   */
  closeOrphanQuestionMessage: (key: SessionKey, messageId: number, messageText: string | null) => Promise<void>;
  /** A person wrote in the topic: the bot-wide effects of that (the idle latch, the todo registry) — and the re-asked question's own end. */
  notePersonActivity: (key: SessionKey) => void;
}

/**
 * @description Build the compaction flow — `/compact`, the compact-on-idle watchdog and its deferred variant —
 * over its ports. It returns the activity hooks the bot's prompt, output and session-lifecycle paths call, the
 * state the typing loop and the request probe read, and the `register…()` calls.
 */
export function createCompaction(ports: CompactionPorts) {
  const { startTypingLoader, forwardPromptToAgent, pendingQuestions, clearPendingQuestion, closeQuestionMessage, idleWindowMs, checkIsLimitWaitArmed, suspendThreadSession, resumeSleepingSessionForCompaction, getThreadAdapter, deliverLabel, resumeSleepingSessionForPrompt, checkIsStarting, closeOrphanQuestionMessage, notePersonActivity, bot, command, getState, replyToThread, editThreadKeyboard, authoriseContext, withThreadLocale, checkIsGeneral, wakeSleepingSession } = ports;

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
    // A tracker issue has no topic to narrate into (R6): its agent asked for the compaction through the bot MCP, and
    // the compaction runs, and fails, silently there — the failure is in the log.
    const isInTopic = checkIsTelegramKey(key);
    const isNarrated = route === 'adapterCompact' && isInTopic;
    // The START notice also needs the session to be live (pure rule): the seam refuses
    // a dead session as its first act, and a "compacting…" ahead of that refusal is a
    // promise the very next message retracts. The seam still re-checks, so a session
    // lost right afterwards just reports the failure as before.
    if (isInTopic && checkShouldAnnounceCompactionStart({ route, isSessionActive: getThreadAdapter(key).checkIsActive(key) })) {
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
      if (isInTopic) await replyToThread(key, result.error ?? t('compact.failed', { reason: 'unknown' }));
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
    clearIdleFireTimer(kStr);
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
    setIdleFireTimer(key, delayMs);
  }

  function clearIdleFireTimer(kStr: string): void {
    const compactionState = getThreadCompactionState(kStr);
    if (!compactionState.idleTimer) return;
    clearTimeout(compactionState.idleTimer);
    compactionState.idleTimer = null;
  }

  /** The thread's ONE idle-fire timer: whoever arms it replaces the one armed before. */
  function setIdleFireTimer(key: SessionKey, delayMs: number): void {
    const compactionState = getThreadCompactionState(keyToString(key));
    if (compactionState.idleTimer) clearTimeout(compactionState.idleTimer);
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
    closeReAskedQuestion(key);
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
      // D2: no reschedule. A real running turn resets the timer via
      // `noteThreadActivity` with its output and its end; every other miss re-arms
      // only on the next genuine USER message (which clears the latch) — except a
      // process kept only by the agent's own pending work, which is looked at
      // again (bounded hold).
      console.log(`[compact-on-idle] ${kStr} process kept: ${decision.suspendSkipReasons.join(', ')}`);
      armPendingWorkRecheck(key, adapter);
      return;
    }
    // A per-turn session is stopped by its own `turnEnded` as the compaction turn ends (L5): nothing left to stop.
    if (!adapter.checkIsActive(key)) {
      console.log(`[compact-on-idle] ${kStr} process already stopped during the idle fire`);
      return;
    }
    if (checkIsThreadWorking(key, adapter)) {
      console.log(`[compact-on-idle] ${kStr} process kept: it started working during the idle fire`);
      armPendingWorkRecheck(key, adapter);
      return;
    }
    await suspendThreadSession(key);
  }

  /**
   * @description The idle fire found the process kept ONLY by the agent's own pending work (background tasks,
   * scheduled jobs, a finished task's turn on its way) — no real turn runs. Look again at the next idle window or when
   * the pending-work hold runs out, whichever is first: a task that never reports produces no output to re-arm the
   * timer, and the hold must still end. A real turn keeps D2's rule — its output re-arms the timer.
   */
  function armPendingWorkRecheck(key: SessionKey, adapter: AgentAdapter): void {
    const kStr = keyToString(key);
    if (!adapter.checkIsActive(key)) return;
    const isRealTurn = checkIsBusyForRealTurn({ isBusy: adapter.checkIsBusy?.(key) ?? false, hasPendingQuestion: pendingQuestions.has(kStr) });
    if (isRealTurn || !(adapter.checkHasBackgroundWork?.(key) ?? false)) return;
    const delayMs = getPendingWorkRecheckDelayMs({ idleWindowMs, holdRemainingMs: adapter.getPendingWorkHoldRemainingMs?.(key) ?? null });
    console.log(`[compact-on-idle] ${kStr} looks again in ${(delayMs / 60_000).toFixed(1)} min: only the agent's own pending work keeps it`);
    setIdleFireTimer(key, delayMs);
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
    // remember it, drop the bot-side pending state (and its pin), then RE-ASK it after the compaction with real buttons
    // that feed a fresh prompt. The old message stays as the record, but is edited only once the re-ask is there
    // ({@link postIdleCompactionResult}): the compaction can take minutes, and «asked again below» would be untrue.
    let reAsked: ReAskedQuestion | null = null;
    if (hasPendingQuestion) {
      const savedQuestion = pendingQuestions.get(kStr) ?? null;
      adapter.rejectQuestion?.(key);
      adapter.sendSignal(key, 'SIGINT');
      clearPendingQuestion(key);
      const question = savedQuestion?.data.questions[savedQuestion.currentIndex];
      if (savedQuestion && question) {
        // From here the question lives in a record of its own, SAVED (a restart during the compaction asks it again at boot,
        // or ends the old message as unanswered when the conversation is gone, instead of forgetting it), and a person who
        // writes, a conversation that ends or a number typed
        // reach it like they reach any re-asked question — so someone who writes meanwhile also stops the re-ask.
        reAsked = startReAskedQuestion(key, question, savedQuestion.messageId);
        // Its buttons are dead from here (the question is no longer pending) and the compaction can take minutes: they come
        // off at once. The text waits for the re-ask's outcome.
        if (savedQuestion.messageId !== null) void editThreadKeyboard(key, savedQuestion.messageId, null, 'idleReask');
      }
    }

    const result = await runThreadCompaction(key, { withClosingSection: true });
    if (!result.ok) {
      console.warn(`[compact-on-idle] ${kStr} compaction failed: ${result.error ?? 'unknown'}`);
      // The compaction failed but the question is already rejected — re-ask it so
      // the user isn't left without the pending decision (no notice: nothing was
      // compacted).
      await postIdleCompactionResult(key, { noticeText: null, summary: null }, reAsked);
      return;
    }
    await postIdleCompactionResult(
      key,
      {
        noticeText: t('compactOnIdle.notice'),
        summary: result.summary ?? null,
      },
      reAsked,
    );
  }

  /**
   * @description Per-thread idle-compaction RE-ASKED question (D1), keyed by {@link SessionKey} string — the record of
   * {@link ReAskedQuestion}, from the start of the compaction on. A `reask_<idx>` tap, or an option NUMBER typed, forwards the
   * label of its option to the (now compacted) session as a FRESH prompt — the original question request was rejected
   * server-side, so it cannot be answered any more — and writes the answer under the question. When the conversation ends
   * instead ({@link closeReAskedQuestion}), or a person writes something else, the message is closed as unanswered, so its
   * buttons never sit there dead nor get tapped later onto whatever the agent asks next. The record is also kept in the saved
   * state, so a restart finds it: its buttons keep working while the conversation sleeps ({@link restoreReAskedQuestion}),
   * and a restart during the compaction asks the question again ({@link reAskInterruptedQuestion}) while the conversation can
   * still be resumed, or closes the old message as unanswered when it is gone.
   */
  const reAskedQuestions = new Map<string, ReAskedQuestion>();

  /**
   * The record as the saved state keeps it: the posted re-ask's message, or — before it is posted — the message the question
   * waited in, flagged as such. `null` when there is no message to remember.
   */
  function buildSavedReAskedQuestion(reAsked: ReAskedQuestion): ReAskedQuestionRecord | null {
    if (reAsked.messageId !== null) {
      // The old message goes with it, and whether its result has landed: a restart between the post and that edit finishes it.
      return reAsked.predecessorMessageId === null
        ? { messageId: reAsked.messageId, question: reAsked.question }
        : { messageId: reAsked.messageId, question: reAsked.question, predecessorMessageId: reAsked.predecessorMessageId, isPredecessorClosed: reAsked.isPredecessorEditLanded };
    }
    if (reAsked.predecessorMessageId !== null) return { messageId: reAsked.predecessorMessageId, question: reAsked.question, isPosted: false };
    return null;
  }

  /**
   * The messages of a topic that already carry a result of a re-asked question — an answer a tap or a number took, or a close that
   * landed — most recent last. A button can still be tapped on such a message from a stale view (a second tap on the spinner the first
   * one left): it must not be taken for a message the bot knows nothing about, whose own text would be rewritten over the result.
   */
  const endedMessageIds = new Map<string, Set<number>>();
  const endedMessageLimit = 100;

  function rememberEndedMessage(key: SessionKey, messageId: number | null): void {
    if (messageId === null) return;
    const kStr = keyToString(key);
    const messageIds = endedMessageIds.get(kStr) ?? new Set<number>();
    messageIds.delete(messageId);
    messageIds.add(messageId);
    if (messageIds.size > endedMessageLimit) {
      const oldest = messageIds.values().next().value;
      if (oldest !== undefined) messageIds.delete(oldest);
    }
    endedMessageIds.set(kStr, messageIds);
  }

  function forgetEndedMessage(key: SessionKey, messageId: number | null): void {
    if (messageId !== null) endedMessageIds.get(keyToString(key))?.delete(messageId);
  }

  function checkIsEndedMessage(key: SessionKey, messageId: number): boolean {
    return endedMessageIds.get(keyToString(key))?.has(messageId) ?? false;
  }

  /** Give a message of the re-asked question its result through the bot's close; one that landed is remembered as ended. */
  async function closeReAskedMessage(key: SessionKey, messageId: number, question: OpenCodeQuestion, ending: QuestionEnd): Promise<boolean> {
    const isEdited = await closeQuestionMessage(key, messageId, question, ending);
    if (isEdited) rememberEndedMessage(key, messageId);
    return isEdited;
  }

  /** Keep the record in the saved state; a failed write is logged, the in-memory record is what a tap reads. */
  function saveReAskedQuestion(key: SessionKey, reAsked: ReAskedQuestion): void {
    const record = buildSavedReAskedQuestion(reAsked);
    if (record === null) return;
    getState().setReAskedQuestion(key, record).catch((e) => console.error('[reAskedQuestion] persist failed:', e));
  }

  /** Drop the re-asked question from the saved state; a failed write is logged. */
  function forgetSavedReAskedQuestion(key: SessionKey): void {
    getState().clearReAskedQuestion(key).catch((e) => console.error('[reAskedQuestion] clear failed:', e));
  }

  /**
   * The idle compaction takes a pending question over: the record starts in its COMPACTING phase, saved at once. The old
   * message is the predecessor (`null` when it never got an id).
   */
  function startReAskedQuestion(key: SessionKey, question: OpenCodeQuestion, predecessorMessageId: number | null): ReAskedQuestion {
    const reAsked: ReAskedQuestion = {
      question,
      messageId: null,
      predecessorMessageId,
      isPredecessorClosed: false,
      isPredecessorEditLanded: false,
      ending: null,
      isAnswerPending: false,
      sendPhase: 'notStarted',
      hasIdleResultRun: false,
    };
    reAskedQuestions.set(keyToString(key), reAsked);
    saveReAskedQuestion(key, reAsked);
    return reAsked;
  }

  /** The record is over without a result to write (its send failed): out of memory and of the saved state. */
  function dropReAskedQuestion(key: SessionKey): void {
    reAskedQuestions.delete(keyToString(key));
    forgetSavedReAskedQuestion(key);
  }

  /** The re-asked question a `reask_<idx>` tap or a typed number works on, still kept. */
  function peekReAskedQuestion(key: SessionKey): ReAskedQuestion | undefined {
    return reAskedQuestions.get(keyToString(key));
  }

  /**
   * @description A tap takes the re-asked question out of memory and of the saved state: it is used now, so nothing closes
   * its message as unanswered any more (the tap writes the answer there), and a restart does not bring it back. An `ending`
   * is what a re-ask still being sent writes on its message when it lands (the end of the conversation).
   */
  function takeReAskedQuestion(key: SessionKey, ending: QuestionEnd | null = null): ReAskedQuestion | undefined {
    const kStr = keyToString(key);
    const reAsked = reAskedQuestions.get(kStr);
    if (!reAsked) return undefined;
    reAskedQuestions.delete(kStr);
    reAsked.ending = ending;
    forgetSavedReAskedQuestion(key);
    return reAsked;
  }

  /**
   * @description A number typed answers the question: the record is taken like a tap's, with no ending yet and
   * {@link ReAskedQuestion.isAnswerPending} set. The label may still reach no session, and then the question is open again, so
   * the answer is written by {@link answerReAskedQuestion} once the delivery is known.
   */
  function takeReAskedQuestionForAnswer(key: SessionKey): ReAskedQuestion | undefined {
    const reAsked = takeReAskedQuestion(key);
    if (!reAsked) return undefined;
    reAsked.isAnswerPending = true;
    rememberAnsweredMessages(key, reAsked, reAsked.messageId);
    return reAsked;
  }

  /**
   * A tap or a number took the question to answer it: the copy (`copyMessageId`, which a tap may know before the record does) and
   * the old message are going to carry that answer, so a second tap on either — from a stale view, while the first is still being
   * delivered — answers nothing and rewrites nothing.
   */
  function rememberAnsweredMessages(key: SessionKey, reAsked: ReAskedQuestion, copyMessageId: number | null): void {
    rememberEndedMessage(key, copyMessageId);
    rememberEndedMessage(key, reAsked.predecessorMessageId);
  }

  /**
   * @description The label of a taken question reached the agent: write `answer` as its result on its messages — the re-ask's
   * own if it is known (one that lands later ends the same way), and the predecessor if it has no result yet.
   */
  async function answerReAskedQuestion(key: SessionKey, reAsked: ReAskedQuestion, answer: string): Promise<void> {
    reAsked.isAnswerPending = false;
    reAsked.ending = { answer };
    await endReAskedQuestion(key, reAsked);
  }

  /**
   * A tap whose label reached no session leaves the question open: the record goes back, unless a newer one took its place.
   * Resolves whether it went back — when not, the tapped message is no longer the question that waits.
   */
  function putBackReAskedQuestion(key: SessionKey, reAsked: ReAskedQuestion): boolean {
    if (reAskedQuestions.has(keyToString(key))) return false;
    reAsked.ending = null;
    reAsked.isAnswerPending = false;
    reAskedQuestions.set(keyToString(key), reAsked);
    saveReAskedQuestion(key, reAsked);
    return true;
  }

  /**
   * Boot: a saved re-asked question whose conversation can still be resumed gets its buttons back (memory only, it is saved already).
   * A restart between the post of the copy and the edit of the old message leaves the old message without a note: it gets it now.
   */
  function restoreReAskedQuestion(key: SessionKey, saved: ReAskedQuestionRecord): void {
    const isPredecessorSettled = saved.predecessorMessageId === undefined || saved.predecessorMessageId === null || saved.isPredecessorClosed !== false;
    const reAsked: ReAskedQuestion = {
      question: saved.question,
      messageId: saved.messageId,
      predecessorMessageId: saved.predecessorMessageId ?? null,
      isPredecessorClosed: isPredecessorSettled,
      isPredecessorEditLanded: isPredecessorSettled,
      ending: null,
      isAnswerPending: false,
      sendPhase: 'finished',
      hasIdleResultRun: true,
    };
    reAskedQuestions.set(keyToString(key), reAsked);
    settleReAskedPredecessor(key, reAsked).catch((e) => console.error('[reAskedQuestion] settling the old message at boot failed:', e));
  }

  /**
   * Boot: a saved re-asked question that cannot be brought back (its conversation is gone, or a question waits beside it) ends:
   * its message — and the old message, if the restart left that without a note — is closed as unanswered, never left with buttons that
   * do nothing or would answer the wrong question, and the saved record is dropped. An unposted record names the old message itself.
   */
  function closeSavedReAskedQuestion(key: SessionKey, saved: ReAskedQuestionRecord): void {
    forgetSavedReAskedQuestion(key);
    const messageIds = [saved.messageId];
    if (saved.isPosted !== false && saved.predecessorMessageId != null && saved.isPredecessorClosed === false) messageIds.push(saved.predecessorMessageId);
    for (const messageId of messageIds) {
      closeReAskedMessage(key, messageId, saved.question, 'unanswered')
        .catch((e) => console.error('[reAskedQuestion] closing the saved question failed:', e));
    }
  }

  /**
   * @description Write the record's `ending` on its messages: the re-ask's own, if it is known, and the predecessor, if it has
   * no result yet (a re-ask that ends before it is posted ends the question where it waited). A copy that lands later is closed
   * by {@link postReAskedQuestion} with the same ending.
   */
  async function endReAskedQuestion(key: SessionKey, reAsked: ReAskedQuestion): Promise<void> {
    const ending = reAsked.ending;
    if (ending === null) return;
    if (reAsked.messageId !== null) await closeReAskedMessage(key, reAsked.messageId, reAsked.question, ending);
    if (reAsked.predecessorMessageId !== null && !reAsked.isPredecessorClosed) {
      reAsked.isPredecessorClosed = true;
      await closeReAskedMessage(key, reAsked.predecessorMessageId, reAsked.question, ending);
    }
  }

  /**
   * @description The re-asked question will not be tapped any more — its conversation ended (session closed or stopped,
   * `/quit`, `/quit-all`, `/new`, leaving the folder, another conversation picked), a person wrote something else, or the
   * agent asked a newer question: forget it and close its message as unanswered — the question stays, the buttons go. In
   * the compaction's own phase the message that closes is the one the question waited in. A re-ask whose send is still in
   * flight has no message id yet: its ending is set, and the send closes the message when it lands. A question used by a
   * tap is no longer here, so its answer is never overwritten.
   */
  function closeReAskedQuestion(key: SessionKey): void {
    const reAsked = takeReAskedQuestion(key, 'unanswered');
    if (!reAsked) return;
    endReAskedQuestion(key, reAsked).catch((e) => console.error('[reAskedQuestion] close failed:', e));
  }

  /**
   * @description Post the RE-ASKED question (D1) with its option buttons — the record is in the map already, in its COMPACTING
   * phase, so a `reask_<idx>` tap that lands right after the send finds it and can forward the chosen label as a fresh
   * prompt. Its message id is recorded once the send resolves (and the record saved, unless a tap or an ending took it
   * meanwhile). Resolves that id — `null` when the send failed, and then there is no record either: nothing was posted that
   * a tap could be on.
   */
  async function postReAskedQuestion(key: SessionKey, text: string, reAsked: ReAskedQuestion): Promise<number | null> {
    const keyboard = buildQuestionOptionsKeyboard(reAsked.question, (optionIndex) => `reask_${optionIndex}`);
    reAsked.sendPhase = 'inFlight';
    const sentMessageId = await replyToThread(key, text, buildKeyboardExtra(keyboard));
    reAsked.sendPhase = 'finished';
    const isStillKept = reAskedQuestions.get(keyToString(key)) === reAsked;
    if (sentMessageId === null) {
      if (isStillKept) dropReAskedQuestion(key);
      return null;
    }
    reAsked.messageId = sentMessageId;
    // The conversation ended (or a number answered) while the send was in flight: the message that landed ends the same way.
    if (reAsked.ending !== null) await endReAskedQuestion(key, reAsked);
    else if (isStillKept) saveReAskedQuestion(key, reAsked);
    // Taken to be answered (a tap or a number): the copy that landed is going to carry the answer.
    else rememberEndedMessage(key, sentMessageId);
    return sentMessageId;
  }

  /** The text of the re-asked question's message: the sentence that says it is asked again, then the question (its options are the buttons). */
  function buildReAskedQuestionText(question: OpenCodeQuestion): string {
    return [
      t('compactOnIdle.pendingQuestionReask'),
      question.header ? `${question.header}\n${question.question}` : question.question,
    ].join('\n\n');
  }

  /**
   * @description Boot: the bot stopped between the start of an idle compaction and the re-ask of its question, so `saved` names
   * the message the question waited in (its buttons off, no result yet). The question was rejected on the agent's side, and
   * nobody has had the chance to answer it — so, when the conversation can still be resumed, it is asked again NOW, by the very
   * post the idle fire makes, and the old message says so. A re-ask that cannot be sent ends the old message as unanswered, as
   * in the idle fire.
   */
  async function reAskInterruptedQuestion(key: SessionKey, saved: ReAskedQuestionRecord): Promise<void> {
    await withThreadLocale(key, async () => {
      const reAsked = startReAskedQuestion(key, saved.question, saved.messageId);
      reAsked.hasIdleResultRun = true;
      await postReAskedQuestion(key, buildReAskedQuestionText(saved.question), reAsked);
      await settleReAskedPredecessor(key, reAsked);
    });
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
   *
   * The re-ask is posted only if its record is still kept: someone who wrote while the compaction ran, a conversation that
   * ended, or a number typed has ended it already, and then the old message has its result.
   */
  async function postIdleCompactionResult(
    key: SessionKey,
    parts: { noticeText: string | null; summary: string | null },
    reAsked: ReAskedQuestion | null,
  ): Promise<void> {
    const questionText = reAsked ? buildReAskedQuestionText(reAsked.question) : null;

    // A tracker issue has no topic to narrate into (R6): the compaction and the stop stay silent there.
    if (!checkIsTelegramKey(key)) return;
    const plan = buildIdleCompactionNoticeParts({ ...parts, questionText });
    if (plan.notice) await replyToThread(key, plan.notice);
    if (plan.summary) await postCompactionSummary(key, plan.summary);
    if (!reAsked) return;
    // From here the re-ask is decided: a record taken meanwhile (a number typed) is not posted, and whoever puts it back finishes it.
    reAsked.hasIdleResultRun = true;
    if (plan.question && peekReAskedQuestion(key) === reAsked) await postReAskedQuestion(key, plan.question, reAsked);
    await settleReAskedPredecessor(key, reAsked);
  }

  /**
   * @description The old question message stays as the record. It says "asked again below" only once there IS a copy below — if
   * the re-ask could not be sent, nobody answered it and nobody will be asked again. An ending written on it already (a person
   * wrote, the conversation ended) stands, and so does the result of a number whose delivery is under way: that answer
   * writes it, or puts the question back and settles the predecessor again.
   */
  async function settleReAskedPredecessor(key: SessionKey, reAsked: ReAskedQuestion): Promise<void> {
    if (reAsked.ending !== null || reAsked.isAnswerPending || reAsked.predecessorMessageId === null || reAsked.isPredecessorClosed) return;
    reAsked.isPredecessorClosed = true;
    const isEdited = await closeReAskedMessage(key, reAsked.predecessorMessageId, reAsked.question, reAsked.messageId !== null ? 'askedAgain' : 'unanswered');
    if (!isEdited) return;
    // Saved only now, so a restart before the edit landed finds the old message unsettled and finishes it.
    reAsked.isPredecessorEditLanded = true;
    if (reAskedQuestions.get(keyToString(key)) === reAsked) saveReAskedQuestion(key, reAsked);
  }

  /**
   * @description A tap on a button of the question the idle compaction asked again (D1). The original request was rejected
   * on the agent's side during the compaction, so the chosen option's label is delivered to the (now compacted) conversation
   * as a FRESH prompt, not answered. Once it is delivered the re-asked message stays as the record: the question as asked,
   * the chosen answer in place of the buttons.
   */
  async function handleReAskedQuestionTap(ctx: Context, optionIndex: number): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    const tappedMessageId = getCallbackMessageId(ctx);
    const reAsked = peekReAskedQuestion(key);
    // A re-ask whose send has not returned has no message id, and when the old message has none either there is nothing to tell
    // the tapped message from an older copy by: no tap is taken until the id is known, and none is rewritten.
    if (reAsked !== undefined && reAsked.messageId === null && reAsked.predecessorMessageId === null) {
      await ctx.answerCbQuery(t('cb.no_pending_question'));
      return;
    }
    // The tap must be on the message of the question that waits now. A button left on an OLDER re-asked message (its close
    // failed, or it predates a restart) would answer the newer question with that question's own label: it answers nothing,
    // and its buttons come off. A re-ask whose send has not returned has no message id yet — the tap is on that message if
    // it is NEWER than the one the question waited in before (the re-ask is always posted after it); older ones are the stale ones.
    const isTappedMessageCurrent = reAsked !== undefined && (reAsked.messageId !== null
      ? reAsked.messageId === tappedMessageId
      : tappedMessageId !== null && reAsked.predecessorMessageId !== null && tappedMessageId > reAsked.predecessorMessageId);
    if (!isTappedMessageCurrent) {
      await ctx.answerCbQuery(t('cb.no_pending_question'));
      // A message that already carries a result (an answer a first tap is still delivering, a close that landed) is left as it is:
      // a second tap from a stale view must not rewrite it. Only a message the bot knows nothing about is closed here.
      if (tappedMessageId === null || checkIsEndedMessage(key, tappedMessageId)) return;
      rememberEndedMessage(key, tappedMessageId);
      // Not awaited: the edit waits its turn in the send pacer, and the next update of the topic waits for this handler.
      closeOrphanQuestionMessage(key, tappedMessageId, getCallbackMessageText(ctx)).catch((e) => console.error('[reask] closing the tapped orphan failed:', e));
      return;
    }
    const label = reAsked.question.options[optionIndex]?.label;
    if (!label) { await ctx.answerCbQuery(t('cb.invalid_option')); return; }
    // The question is taken before anything is awaited and put back if the label reaches no one: from here on it is this
    // tap's, so no other path can use it or close it under the answer.
    takeReAskedQuestion(key);
    const reAskedMessageId = reAsked.messageId ?? tappedMessageId;
    rememberAnsweredMessages(key, reAsked, reAskedMessageId);
    // The idle fire posts the re-asked question just BEFORE it stops the process, and a stopping process still reads as
    // active: a tap inside that window (or inside a start) is buffered like a typed prompt and replayed once a session is up.
    // The answer to a re-asked question wakes a sleeping conversation (L-D4) — the question is its own.
    if (!checkIsStarting(key) && !getThreadAdapter(key).checkIsActive(key) && !(await resumeSleepingSessionForPrompt(key))) {
      await returnReAskedQuestionAfterTap(key, reAsked, reAskedMessageId);
      await ctx.answerCbQuery(t('agent.no_session'));
      return;
    }
    // The closed question carries the whole label, so the toast may cut it; it is posted whole only if that close fails.
    const isLabelCut = await answerCallbackWithFittedText(ctx, label);
    // An answer to the agent's own question is never a request (S7), even delivered as a prompt. Routed at delivery,
    // not on the `checkIsStarting` read above: the stop may have ended during the toast, and a label buffered into its closed
    // window was never replayed.
    const outcome = await deliverLabel(key, label);
    // The label reached no session (the topic was told why): the question is still open, so are its buttons.
    if (outcome === 'noSession') {
      await returnReAskedQuestionAfterTap(key, reAsked, reAskedMessageId);
      return;
    }
    const isAnswerShown = reAskedMessageId !== null && await closeReAskedMessage(key, reAskedMessageId, reAsked.question, { answer: label });
    if (!isAnswerShown && isLabelCut) await replyToThread(key, label);
  }

  /**
   * @description A bare option NUMBER typed while the question the idle compaction asks again waits — for its re-ask (the
   * compaction runs: the buttons are off, the numbered options are still on screen) or for a tap — answers it, like a tap on
   * that option: the label goes to the agent as a fresh prompt and the answer is written under the question. Without this the
   * number would count as the person writing something else: the question would end «not answered» and the agent would get a
   * bare «2». Resolves whether the text was such a number (and was handled).
   */
  async function answerReAskedQuestionByNumber(key: SessionKey, text: string): Promise<boolean> {
    const reAsked = peekReAskedQuestion(key);
    if (!reAsked) return false;
    const route = getQuestionReplyRoute(text, reAsked.question);
    if (route.kind !== 'answer') return false;
    const label = route.labels[0];
    // Taken before anything is awaited, so no other path uses or closes it, but with no result written yet: the label may reach no
    // session, and a re-ask that lands meanwhile is left as it is until that is known.
    takeReAskedQuestionForAnswer(key);
    // A person wrote — the latch clears like for any message; the record is gone, so nothing is closed as «not answered».
    notePersonActivity(key);
    const outcome = await deliverLabel(key, label);
    if (outcome === 'noSession') {
      const isPutBack = await returnReAskedQuestionAfterTap(key, reAsked, reAsked.messageId ?? reAsked.predecessorMessageId);
      if (isPutBack) await finishReAskAfterNumberFoundNoSession(key, reAsked);
      return true;
    }
    await answerReAskedQuestion(key, reAsked, label);
    return true;
  }

  /**
   * @description A typed number found no session and the question is open again. The idle fire decides about the re-ask once, and
   * it skips a record a number has taken (an answer was on its way): so what the fire left undone is done here, once it has run.
   *  - the fire has not run yet — it will post the re-ask itself, now that the record is back;
   *  - its send is in flight — the fire settles the old message when the copy lands;
   *  - the fire ran and sent nothing — the re-ask is posted now, and the old message points at it (or ends «not answered» if the
   *    send fails);
   *  - the copy is there already, the old message waiting for the answer's outcome — it says where the question went.
   */
  async function finishReAskAfterNumberFoundNoSession(key: SessionKey, reAsked: ReAskedQuestion): Promise<void> {
    if (!reAsked.hasIdleResultRun || reAsked.sendPhase === 'inFlight') return;
    if (reAsked.sendPhase === 'notStarted') {
      await withThreadLocale(key, () => postReAskedQuestion(key, buildReAskedQuestionText(reAsked.question), reAsked));
    }
    await settleReAskedPredecessor(key, reAsked);
    // A send that failed leaves nothing to answer: the question ended on the old message.
    if (reAsked.messageId === null && peekReAskedQuestion(key) === reAsked) dropReAskedQuestion(key);
  }

  /**
   * @description A tap on a re-asked question whose label reached no session leaves the question open: its record goes back.
   * Not when a newer re-ask has taken its place meanwhile — the tapped message is not the question that waits any more,
   * so it is closed as unanswered instead of keeping buttons that would answer the wrong question. Resolves whether it went back.
   */
  async function returnReAskedQuestionAfterTap(key: SessionKey, reAsked: ReAskedQuestion, messageId: number | null): Promise<boolean> {
    if (putBackReAskedQuestion(key, reAsked)) {
      // The answer did not happen: the message is an open question again, not one that carries a result.
      forgetEndedMessage(key, messageId);
      return true;
    }
    if (messageId !== null) await closeReAskedMessage(key, messageId, reAsked.question, 'unanswered');
    return false;
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
    // Answer the tap BEFORE the confirmation: it waits in the paced send queue, which under a 429 can
    // outlive the callback, and a late answer throws — skipping the keyboard re-render below.
    await ctx.answerCbQuery();
    await withThreadLocale(key, () => apply(key, isGeneral));
    // Re-render the picker keyboard so the ✓ follows the new state.
    const pickerMessageId = getCallbackMessageId(ctx);
    if (pickerMessageId !== null) {
      const keyboard = withThreadLocale(key, () => buildCompactOnIdleKeyboard(getCompactOnIdlePickerState(key, isGeneral)));
      await editThreadKeyboard(key, pickerMessageId, keyboard.reply_markup, 'coi_cb');
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
    // Answered first for the reason given in `handleCompactOnIdleCallback`.
    await ctx.answerCbQuery();
    await withThreadLocale(key, async () => {
      await replyToThread(key, await applyCompactSummary(key, isGeneral, enabled));
    });
    const pickerMessageId = getCallbackMessageId(ctx);
    if (pickerMessageId !== null) await editThreadKeyboard(key, pickerMessageId, buildCompactSummaryKeyboard(enabled).reply_markup, 'csum_cb');
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

    bot.action(/^reask_(\d+)$/, (ctx) => handleReAskedQuestionTap(ctx, parseInt(ctx.match[1], 10)));
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
    answerReAskedQuestionByNumber,
    reAskInterruptedQuestion,
    restoreReAskedQuestion,
    closeSavedReAskedQuestion,
    closeReAskedQuestion,
    registerCompactionCommands,
    registerCompactionCallbacks,
  };
}
