/**
 * @description Pure decision + text helpers for the compact-on-idle feature and
 * the shared closing-section instruction (plan
 * `agent/tasks/actual/2026-09-14-self-compact-and-compact-on-idle.md`, F2).
 *
 * Kept out of `bot.ts` (which cannot be imported by tests — its module-scope
 * `parseEnv()` exits without a bot token) so every branch is unit-testable,
 * mirroring `getCompactCommandRoute` in `compactCommandRoute.ts`.
 */

import type { CompactCommandRoute } from './compactCommandRoute';
import { resolveDefaultOnThreadToggle, resolveThreadToggle } from './threadToggle';
import { getMinutesOverrideMs } from './minutesOverride';
import { describeWorkingSignals, getIdleHeldNoticeReason, type BackgroundWorkSignal, type IdleHeldNoticeReason, type WorkingSignal } from './workingSignals';

/**
 * Idle interval before an untouched, idle agent session is auto-compacted (F2)
 * and, on a backend that can be suspended, stopped (lifecycle plan L3). Chosen
 * to fire just inside the ~1h Anthropic extended prompt-cache window, so the
 * compaction reads the still-warm cached prefix cheaply and a resume minutes
 * later still finds the cache. `AGENT_IDLE_MINUTES` overrides it for a test or
 * live-test instance only (L-D9) — see {@link getAgentIdleMs}.
 */
export const idleCompactMs = 55 * 60 * 1000;

/**
 * @description The idle window, honouring the `AGENT_IDLE_MINUTES` override (a
 * test needs minutes, not an hour; same pattern as `REQUEST_BACKSTOP_MINUTES`).
 * A missing, non-numeric or non-positive value keeps {@link idleCompactMs}.
 */
export function getAgentIdleMs(overrideMinutes: string | undefined): number {
  return getMinutesOverrideMs(overrideMinutes, idleCompactMs);
}

/**
 * Floor delay for an OVERDUE arm (the thread has been idle longer than
 * {@link idleCompactMs}, across one or more bot restarts). Never fire instantly at
 * boot: the reattach is still adopting sessions and the topic may be about to
 * receive a real prompt, so give it a minute of grace first. At a shortened idle window (a test's) it
 * shortens in proportion, see {@link getIdleCompactionArmDecision}.
 */
export const compactIdleOverdueMinDelayMs = 60_000;

/**
 * Window the overdue arms are SPREAD over, on top of
 * {@link compactIdleOverdueMinDelayMs}. See {@link getIdleCompactionArmDecision}
 * for why the spread exists.
 */
export const compactIdleOverdueSpreadMs = 10 * 60 * 1000;

/**
 * Deterministic non-negative string hash (FNV-1a over UTF-16 code units). Local
 * and dependency-free on purpose: its only job is to derive a STABLE per-thread
 * offset inside the overdue spread, so "same key ⇒ same delay" is testable and no
 * two topics need to coordinate. Not a security primitive.
 */
function getStableHash(text: string): number {
  const fnvOffsetBasis = 0x811c9dc5;
  const fnvPrime = 0x01000193;
  let hash = fnvOffsetBasis;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, fnvPrime);
  }
  // `>>> 0` turns the signed 32-bit result of `Math.imul` into a non-negative int.
  return hash >>> 0;
}

/**
 * Which of {@link getIdleCompactionArmDecision}'s three cases produced a delay.
 * Returned ALONGSIDE the delay rather than re-derived by the caller: the pure
 * function owns the boundaries, and a diagnostic that recomputes them from the same
 * inputs would start naming a case the timer is not in the moment one boundary
 * moves — a log that can lie is worse than no log.
 */
export type IdleCompactionArmKind = 'fullWindow' | 'remainder' | 'overdue';

/** A {@link getIdleCompactionArmDecision} decision: the delay and which case it came from. */
export interface IdleCompactionArmDecision {
  delayMs: number;
  kind: IdleCompactionArmKind;
}

/**
 * @description When the idle watchdog should fire for a thread, given when that
 * thread was last ACTIVE (persisted, so it survives a restart) — the delay plus
 * which of the three cases produced it.
 *
 * Three cases (reported back as {@link IdleCompactionArmKind}):
 *  - no persisted history (`lastActivityAt === 0`) — a fresh session, or a state
 *    file written before the tracking existed ⇒ the full {@link idleCompactMs}
 *    window, i.e. exactly the pre-persistence behaviour.
 *  - still inside the window ⇒ the REMAINDER, clamped to at most the full window:
 *    a backward wall-clock step (an NTP correction on a VPS) puts `lastActivityAt`
 *    in the FUTURE, which would otherwise make the thread wait the whole window
 *    PLUS the skew — and a skew over ~24.8 days overflows `setTimeout`, which then
 *    fires immediately with a `TimeoutOverflowWarning`. "The remainder can never
 *    exceed the full window" is true by definition and costs nothing to enforce.
 *    The remainder itself is the restart fix: the bot runs in hot-reload mode and
 *    restarts on every code change, so re-arming a flat 55 minutes each time meant
 *    a busy development day never let any topic reach the threshold.
 *  - already past the window (idle across one or more restarts) ⇒ OVERDUE, so
 *    fire soon, but staggered: {@link compactIdleOverdueMinDelayMs} plus a
 *    per-thread offset inside {@link compactIdleOverdueSpreadMs}. The boot
 *    reattach adopts every live session at once; without the stagger every
 *    overdue topic would be stopped (and its session slept) in the same instant.
 *    Spreading them over ~1–11 minutes keeps the backlog orderly,
 *    and deriving the offset from the thread key keeps it deterministic (hence
 *    testable) instead of random. At a shortened window (`AGENT_IDLE_MINUTES`, a
 *    test's) the floor and the spread shorten in the same proportion, so a flow
 *    with a 12 s window does not wait out minutes; at the default window they are
 *    exactly the constants.
 *
 * The stagger being DETERMINISTIC was considered and chosen, not overlooked: a
 * thread whose offset lands near the top of the spread never fires while the bot
 * reloads more often than that offset, and a random offset would eventually get
 * lucky. It is still the wrong trade — a random offset makes the fire time
 * unpredictable and untestable, the starvation it would avoid lasts only while the
 * operator is actively rebuilding (a state that ends), and under reloads that
 * frequent a FULL-window arm starves just as surely, so the stagger is not
 * uniquely affected. Do not re-litigate this as an oversight.
 *
 * An overdue fire does NOT compact (the owner's rule, replacing an earlier decision to compact anyway): the 55-minute interval
 * exists so the compaction TURN reads the still-warm prompt cache, and past the window that cache is gone — compacting then is
 * only an expensive uncached read, the same reason a held mark is never compacted late (see {@link getIdleFireDecision}). The
 * overdue fire only decides the STOP of the idle process; the conversation is compacted at the idle mark of a later period,
 * while the cache is warm.
 */
export function getIdleCompactionArmDecision(input: {
  threadKeyString: string;
  lastActivityAt: number;
  now: number;
  /** The idle window in force ({@link getAgentIdleMs}); the default is {@link idleCompactMs}. */
  idleWindowMs?: number;
}): IdleCompactionArmDecision {
  const idleWindowMs = input.idleWindowMs ?? idleCompactMs;
  if (input.lastActivityAt <= 0) return { delayMs: idleWindowMs, kind: 'fullWindow' };
  const remainingMs = idleWindowMs - (input.now - input.lastActivityAt);
  // Clamped: a backward clock step makes `lastActivityAt` future-dated, and the
  // remainder must never exceed the window it is a remainder of.
  if (remainingMs > 0) return { delayMs: Math.min(remainingMs, idleWindowMs), kind: 'remainder' };
  // Never LONGER than the production constants: a window above the default keeps them.
  const windowRatio = Math.min(1, idleWindowMs / idleCompactMs);
  const spreadMs = Math.max(1, Math.round(compactIdleOverdueSpreadMs * windowRatio));
  return {
    delayMs: Math.round(compactIdleOverdueMinDelayMs * windowRatio) + (getStableHash(input.threadKeyString) % spreadMs),
    kind: 'overdue',
  };
}

/**
 * @description Resolve whether compact-on-idle is enabled for a thread. A
 * per-thread override always wins; otherwise the instance-wide default applies,
 * which is ON when unset (mirrors `traceAllThreads` — the feature ships enabled).
 */
export function resolveCompactOnIdleEnabled(
  globalDefault: boolean | undefined,
  threadOverride: boolean | undefined,
): boolean {
  return resolveDefaultOnThreadToggle(globalDefault, threadOverride);
}

/**
 * @description Resolve whether the full compaction summary is posted for a thread
 * (`/compact_summary`). A per-thread override always wins; otherwise the
 * instance-wide default applies, which is OFF when unset: the operator asked for a
 * compaction to end in one short line, with the summary there only for a topic
 * (or an instance) that turns it on.
 *
 * Unlike compact-on-idle this is read at COMPACTION time rather than used to arm a
 * timer, so it is meaningful in a topic with no live session and is deliberately
 * not gated on one.
 */
export function resolveCompactSummaryEnabled(
  globalDefault: boolean | undefined,
  threadOverride: boolean | undefined,
): boolean {
  return resolveThreadToggle(globalDefault, threadOverride, false);
}

/**
 * @description Resolve whether the compaction summary asks the agent for its self-review section and the bot posts it
 * (`/compact_self_review`). A per-thread override always wins; otherwise the instance-wide default applies, which is ON when
 * unset: the section shipped enabled, so a topic keeps getting it until somebody turns it off.
 *
 * Read at COMPACTION time, like {@link resolveCompactSummaryEnabled}, so it is meaningful in a topic with no live session.
 */
export function resolveCompactSelfReviewEnabled(
  globalDefault: boolean | undefined,
  threadOverride: boolean | undefined,
): boolean {
  return resolveDefaultOnThreadToggle(globalDefault, threadOverride);
}

/**
 * @description Whether the session is busy for a REAL running turn, as opposed
 * to merely idle-WAITING on an unanswered interactive question. Both states make
 * `checkIsBusy` report `true`, but D1 draws them apart: a pending question at idle
 * is a FIRE condition (reject + compact + re-ask), not a reason to hold off, while
 * a genuinely running turn still blocks the idle compaction. So the fire guard
 * treats "busy" as `checkIsBusy && !hasPendingQuestion`.
 */
export function checkIsBusyForRealTurn(input: {
  isBusy: boolean;
  hasPendingQuestion: boolean;
}): boolean {
  return input.isBusy && !input.hasPendingQuestion;
}

/**
 * @description What keeps the process WORKING at the idle fire (L-D2), by name: a real running turn
 * ({@link checkIsBusyForRealTurn} — a pending question excuses the turn, D1) and the background signals the question
 * never excuses (a background task, input not yet taken in, a compaction in flight). The two are read apart so a question
 * pending over a running background task still reads as working: the D1 reject-compact-re-ask would otherwise end in a
 * stop that kills the task. Empty when the process is idle.
 */
export function getWorkingSignalsAtIdle(input: {
  isBusy: boolean;
  hasPendingQuestion: boolean;
  backgroundSignals: readonly BackgroundWorkSignal[];
}): WorkingSignal[] {
  return checkIsBusyForRealTurn(input) ? [{ kind: 'turn' }, ...input.backgroundSignals] : [...input.backgroundSignals];
}

/** Past the pending-work hold's end by this much, the re-check finds the hold spent rather than a few ms left. */
export const pendingWorkRecheckMarginMs = 1000;

/**
 * @description When the idle fire looks again at a process kept ONLY by the agent's own pending work (background
 * tasks, scheduled jobs, a finished task's turn on its way): the next idle window, or the end of the pending-work
 * hold if that comes first. D2's no-reschedule rule does not cover this case: a task nobody hears from produces no
 * output to re-arm the timer, and the hold would never be enforced.
 */
export function getPendingWorkRecheckDelayMs(input: { idleWindowMs: number; holdRemainingMs: number | null }): number {
  if (input.holdRemainingMs === null) return input.idleWindowMs;
  return Math.min(input.idleWindowMs, input.holdRemainingMs + pendingWorkRecheckMarginMs);
}

/**
 * @description Whether the idle mark of the thread's CURRENT idle period was already held: a fire found the process working and
 * forwent its compaction (`lastHeldMarkAt`), and no activity has come since (`lastActivityAt` — activity warms the prompt cache
 * again and starts a new idle period, whose mark may compact). Both instants are persisted, so a restart keeps the answer.
 */
export function checkIsIdleMarkSpent(input: { lastActivityAt: number; lastHeldMarkAt: number }): boolean {
  return input.lastHeldMarkAt > input.lastActivityAt;
}

/** What the idle timer does when it fires: the compaction half and the stop half, each with its reasons. */
export interface IdleFireDecision {
  /** Run the idle compaction (D1/D2). */
  shouldCompact: boolean;
  /** Why the compaction is skipped — logged, since a silent skip was the feature's blind spot. */
  compactionSkipReasons: string[];
  /** Stop the process afterwards, the session kept resumable (L-D1). */
  shouldSuspend: boolean;
  /** Why the process stays. */
  suspendSkipReasons: string[];
  /**
   * This fire forgoes a compaction that was due ONLY because the process is held: the caller remembers the idle mark as held
   * (see {@link getIdleFireDecision}'s `isIdleMarkSpent`). False for a re-check, which has nothing new to remember.
   */
  isIdleMarkHeld: boolean;
  /** What to tell the topic about the forgone compaction — once, at the fire that holds the mark; `null`: nothing to say. */
  heldNoticeReason: IdleHeldNoticeReason | null;
}

/**
 * @description The idle-fire decision, taken the moment the idle timer fires
 * (lifecycle plan L3). Nothing happens to a session that is not there or is
 * WORKING (L-D2: a real running turn, a background task, input not yet taken in,
 * a compaction in flight — a pending interactive question is NOT work, see
 * {@link checkIsBusyForRealTurn}; D1); the next activity re-arms the timer. The reasons name WHICH signals hold the
 * process (`working (busy turn, unconsumed input 2)`).
 *
 * The compaction runs only when the feature is enabled for the thread, the
 * per-thread user-latch is NOT already spent (D2 — after a fire it stays latched
 * until the next genuine USER message re-arms it, so idle compaction runs at most
 * once per user-active period), at least one agent turn has completed since the
 * last compaction (otherwise there is nothing new to compress), and no
 * usage-limit wait is armed (L-D6: a compaction turn would hit the limit).
 *
 * The compaction belongs to the IDLE MARK alone: it exists to read the still-warm prompt cache, which is gone a little after the
 * idle window (`idleCompactMs`), so a compaction later than the mark is only an expensive one. A process held at the mark
 * (a compaction that was otherwise due is then `isIdleMarkHeld`) does NOT get its compaction on a later look: once the mark is
 * spent (`isIdleMarkSpent` — it was held and no activity has re-warmed the cache since) every later fire, the re-checks of a
 * held process, decides only the stop. Nor does a fire whose countdown was armed AFTER the mark had already passed
 * (`isIdleMarkMissed`: the overdue arm — the bot came back from downtime past the window, or a re-spawn or a per-turn wake found
 * the topic idle for longer than that) compact: it decides only the stop too, and a hold at it costs nothing, so there is no
 * mark to hold and nothing to tell.
 * Activity re-arms the countdown, and with it the next mark's compaction.
 *
 * The STOP happens whether or not the compaction runs (L-D1: a resume restores
 * the full history, so a stopped process loses nothing) — on a backend that can
 * be suspended; the tmux TUI and OpenCode stay (L-D8).
 */
export function getIdleFireDecision(input: {
  isSessionActive: boolean;
  /** What holds the process now (empty: idle); see {@link getWorkingSignalsAtIdle}. */
  workingSignals: readonly WorkingSignal[];
  /** The idle mark of this idle period was already held (a fire found the process working and forwent its compaction). */
  isIdleMarkSpent: boolean;
  /** This fire's countdown was armed (the overdue arm) when the idle mark had already passed: the prompt cache is cold. */
  isIdleMarkMissed: boolean;
  isEnabled: boolean;
  isLatched: boolean;
  hasCompletedTurnSinceCompaction: boolean;
  isLimitWaitArmed: boolean;
  canSuspend: boolean;
}): IdleFireDecision {
  const isWorking = input.workingSignals.length > 0;
  const compactionBlockers = [
    !input.isEnabled && 'disabled',
    input.isLatched && 'latched (D2)',
    !input.hasCompletedTurnSinceCompaction && 'nothing to compress',
    input.isLimitWaitArmed && 'a usage-limit wait is armed (L-D6)',
    input.isIdleMarkMissed && 'the idle mark had already passed when the countdown was armed (the prompt cache is cold by now)',
  ].filter((reason): reason is string => typeof reason === 'string');
  const notIdleReasons = [
    !input.isSessionActive && 'no active session',
    isWorking && `working (${describeWorkingSignals(input.workingSignals)})`,
  ].filter((reason): reason is string => typeof reason === 'string');
  if (notIdleReasons.length > 0) {
    const isIdleMarkHeld = input.isSessionActive && isWorking && !input.isIdleMarkSpent && compactionBlockers.length === 0;
    return {
      shouldCompact: false,
      compactionSkipReasons: notIdleReasons,
      shouldSuspend: false,
      suspendSkipReasons: notIdleReasons,
      isIdleMarkHeld,
      heldNoticeReason: isIdleMarkHeld ? getIdleHeldNoticeReason(input.workingSignals) : null,
    };
  }
  const compactionSkipReasons = input.isIdleMarkSpent
    ? [...compactionBlockers, 'the idle mark passed while the process was held (the prompt cache is cold by now)']
    : compactionBlockers;
  return {
    shouldCompact: compactionSkipReasons.length === 0,
    compactionSkipReasons,
    shouldSuspend: input.canSuspend,
    suspendSkipReasons: input.canSuspend ? [] : ['the backend is not suspended'],
    isIdleMarkHeld: false,
    heldNoticeReason: null,
  };
}

/**
 * @description The maximally-complete-summary guidance (D3) — one canonical text
 * used on EVERY bot-issued compaction, kept BACKEND-CONSISTENT: it is baked into
 * the OpenCode fork's compaction prompt (so it also reaches the auto/overflow
 * compaction the bot can't touch) and, for the Claude backends (which have no
 * prompt the bot controls), appended to the `/compact <instruction>` the bot
 * sends. A code constant (not an i18n key) because it is identical across all
 * locales — it dictates WHAT the summary must contain, never its language — and
 * because it must mirror the fork's baked wording without 12-locale drift.
 */
export const compactionSummaryGuidance =
  'Make the summary MAXIMALLY COMPLETE: preserve every detail needed to continue the work from a clean session with no memory of this conversation — never drop load-bearing information (decisions, constraints, file paths, commands, error strings, identifiers, active tasks, delegated-work state) for brevity. Capture only SESSION-SPECIFIC working nuances: the user\'s in-session directives and any deviations from the standard process. Do NOT restate the standard instructions that auto-load at session start (for example CLAUDE.md / AGENTS.md / rules files) — they reload automatically on the fresh session, so duplicating them only wastes the summary. Keep the conversational directives, active exceptions, and delegated-work state; drop the static rulebook.';

/**
 * FIXED (English, locale-independent) sentinel markers of the loaded-skills block, the one place a summary names its
 * skills for a machine: the OpenCode plugin reads the block ({@link parseCompactionLoadedSkills}) to know which skills to
 * restore after the compaction, beside the skill tool calls it finds in the session's history. Sentinels for the same reason
 * as {@link compactionClosingStartMarker}; the guidance below pins these exact strings.
 *
 * The Claude restore hook cannot read the block of the compaction it follows. Measured on Claude Code 2.1.322 (`-p`, stream-json,
 * a manual `/compact` and three automatic mid-turn compactions): the hooks run `PreCompact` → `SessionStart` (source
 * `compact`) → `PostCompact`, and while the `SessionStart` hooks run the transcript holds neither the new `compact_boundary`
 * nor the new `isCompactSummary` record (only the previous compaction's). So on Claude the transcript's skill records are the
 * whole source; the block still serves OpenCode, whose plugin reads the finished summary.
 */
export const compactionSkillsBlockStartMarker = '<<<LOADED_SKILLS>>>';
export const compactionSkillsBlockEndMarker = '<<<END_LOADED_SKILLS>>>';

/** The longest line the block holds as a skill name: longer is no name. */
export const compactionSkillsBlockMaxNameLength = 128;

/**
 * @description The loaded-skills block guidance: the summary names every skill that was loaded, one exact name per line
 * between {@link compactionSkillsBlockStartMarker} and {@link compactionSkillsBlockEndMarker}. The bot hides the block from the
 * topic ({@link createCompactionSummaryLineFilter}) and the OpenCode plugin reads it. ONE line of printable ASCII with no double
 * quote or backslash, for the `PreCompact` hook's fixed-string match (see {@link compactionChecklistGuidance}).
 */
export const compactionSkillsBlockGuidance =
  `Write the exact name of every skill that was loaded (invoked) in this session, never translated or shortened (a namespaced name such as plugin:skill stays whole), one name per line with nothing else on it, in a block of its own wrapped EXACTLY between a line containing only ${compactionSkillsBlockStartMarker} and a line containing only ${compactionSkillsBlockEndMarker}, placed before the numbered checklist and before any closing section. If no skill was loaded, leave the block out.`;

/**
 * @description The loaded-skills guidance. A skill is loaded on demand mid-session (a tool call whose result carries its
 * instructions), so — unlike CLAUDE.md / AGENTS.md — the summary drops its text. Where the bot can, it puts the text back
 * itself right after the compaction (`utils/skillsRestore.ts`); where it cannot (the frozen tmux backend, a process started
 * before the restore existed, an OpenCode instance that has not loaded the current plugin yet), the continuing session must
 * load the skills again. The bot-issued instruction cannot know which case a compaction is in, so the summary says both, and
 * what the continuing session finds in its own context decides. Worded without the restore's header and without saying
 * WHERE the restore sits: the summary is shown to the person (`/compact_summary`), who must see nothing of the restore, and
 * the restore comes before the summary on OpenCode and after it on Claude. It travels with {@link compactionChecklistGuidance}
 * as {@link compactionResumeGuidance}.
 */
export const compactionSkillsGuidance =
  'Then state in plain words that these skills stay in force for the continuing session: it must load each of them again and follow it before resuming the work, unless their full text was restored to it right after the compaction (then it must NOT load them again), since this summary does not carry the instructions of a skill. If no skill was loaded, omit this.';

/**
 * @description The "what to do next" checklist every compaction summary ends with.
 * Item 1 ({@link compactionChecklistSkillsItem}) names the skills of the block (exactly, so the continuing session cannot
 * paraphrase a name into one that does not load) and says when they need no loading; the rest are the next steps the summary already records, in order —
 * never invented ones. With a closing section requested, the list is that section's
 * last part, right before its end marker, so "write nothing after the end marker"
 * still holds; otherwise it ends the summary. A code constant for the same reason as
 * {@link compactionSummaryGuidance}: one text for every path, no locale in it. It is
 * ONE line of printable ASCII with no double quote or backslash, because the
 * `PreCompact` hook matches it as a fixed string in the raw JSON it reads on stdin.
 */
/** What checklist item 1 opens with, before the skills' names: the text the summary shows the person, so a test copies it as is. */
export const compactionChecklistSkillsItem = 'skills in force (load them again only if their full text was not restored to you right after the compaction):';

export const compactionChecklistGuidance =
  `End the summary with a numbered checklist (1., 2., 3., one short item per line) of what the continuing session does next, as the very LAST thing in it. Item 1 is '${compactionChecklistSkillsItem}' followed by the exact name of every skill in that block, never translated or shortened; if none was loaded, leave that item out. The other items are the next steps this summary already records, in order: invent no new steps. If you are also asked to write a closing section between two marker lines, the checklist is the last part of that section, right before its end marker.`;

/**
 * FIXED (English, locale-independent) sentinel markers the self-review section is wrapped in, and the one line
 * the section holds when there were none. Sentinels for the same reason as {@link compactionClosingStartMarker}:
 * the backends write very different summary formats, so exact marker lines are the one backend-agnostic way to lift
 * the section out of a summary ({@link extractCompactionInstructionGaps}). The guidance below pins these exact strings.
 */
export const compactionGapsStartMarker = '<<<INSTRUCTION_GAPS>>>';
export const compactionGapsEndMarker = '<<<END_INSTRUCTION_GAPS>>>';
export const compactionNoGapsLine = 'NO_INSTRUCTION_GAPS';

/**
 * @description The self-review guidance: the summary gets a section (the agent's self-review) of this session's mistakes — the repeated ones
 * above all — that a change to the agent's standing instructions could have prevented, each with the concrete change and
 * where it goes. The BOT lifts the section out of the summary and posts it to the topic even when the full summary is
 * hidden ({@link checkShouldPostInstructionGaps}), so the person sees what to fix in the instructions without opening a
 * summary. `/compact_self_review` switches it off: the text then leaves every compaction's prompt ({@link compactionResumeGuidanceWithoutGaps})
 * and nothing is posted. It is written in the language the conversation was held in (the hook and the plugin that carry this text are
 * shared by every topic, so no locale can be baked in), PROPOSES and never edits (the person decides), and sits before the
 * checklist and any closing section, which stay last. Travels with {@link compactionSkillsGuidance} and
 * {@link compactionChecklistGuidance} as {@link compactionResumeGuidance} (ahead of them), so ONE line of printable ASCII with no double
 * quote or backslash, for the `PreCompact` hook's fixed-string match.
 */
export const compactionGapsGuidance =
  `List the mistakes the agent made in this session, especially REPEATED ones, that a change to its standing instructions (rules, skills, CLAUDE.md / AGENTS.md) could prevent: for each, the mistake, then the concrete instruction change that would prevent it and where that change would go. Put that list in its own section wrapped EXACTLY between a line containing only ${compactionGapsStartMarker} and a line containing only ${compactionGapsEndMarker}, placed before the numbered checklist and before any closing section, and write it in the language the user used in this conversation. If there were no such mistakes, write only the single line ${compactionNoGapsLine} between those two marker lines. The continuing session must only PROPOSE these changes to the user and wait for approval: it must never write or change instructions on its own.`;

/**
 * @description The resume guidance WITHOUT the self-review section: the loaded-skills block, the loaded skills and the
 * next-steps checklist. What a compaction asks for while `/compact_self_review` is off, and the part every variant of
 * {@link compactionResumeGuidance} carries — so the one text the `PreCompact` hook matches to skip a compaction that already
 * holds the guidance, whichever variant the bot sent.
 */
export const compactionResumeGuidanceWithoutGaps = `${compactionSkillsBlockGuidance} ${compactionSkillsGuidance} ${compactionChecklistGuidance}`;

/**
 * @description What the continuing session needs from EVERY compaction summary — the
 * self-review section, the loaded-skills block, the loaded skills and the next-steps checklist — as the one text each path
 * carries: a bot-issued compaction in its instruction ({@link buildCompactionInstruction}),
 * and each backend's own overflow compaction through a bot-installed hook — Claude's
 * `PreCompact` hook (`claudeCompactHook.ts`, which also matches on this exact text to
 * skip a compaction that already carries it) and OpenCode's compaction plugin
 * (`openCodeCompactPlugin.ts`). The checklist stays LAST: each sentence says where it goes in the summary, so the order
 * of the sentences is free.
 *
 * A process started before the current text keeps its own hook (adopted across hot reloads, hooks are read at start), and
 * that hook skips a compaction only by finding the text IT carries. The self-review sentence was added ahead of the older
 * text for that reason; the skills restore had to reword the skills sentence and checklist item 1 (they no longer say
 * "load these skills" unconditionally), so such a process's hook no longer finds its text in a bot-issued instruction and
 * appends its own: until that process stops at its idle mark, a `/compact` there reads both texts. Both then lead to the
 * same thing — such a process has no restore hook, so the summary's conditional wording tells it to load the skills again,
 * as its old text does.
 */
export const compactionResumeGuidance = `${compactionGapsGuidance} ${compactionResumeGuidanceWithoutGaps}`;

/** @description The resume guidance a compaction carries: with the self-review section while `/compact_self_review` is on, without it while off. */
export function getCompactionResumeGuidance(isWithInstructionGaps: boolean): string {
  return isWithInstructionGaps ? compactionResumeGuidance : compactionResumeGuidanceWithoutGaps;
}

/**
 * @description Compose the per-invocation compaction instruction the bot passes
 * to a backend (D3 + the resume guidance + F2 closing section). The general summary
 * guidance is appended ONLY when the backend does NOT already bake it into its
 * own prompt — OpenCode bakes it in the fork (`bakesSummaryGuidance: true`) so
 * re-sending it would duplicate the text, whereas the Claude backends have no
 * bot-controlled prompt and must receive it every time. The resume guidance
 * ({@link compactionResumeGuidance}: the self-review section, the loaded skills and the next-steps checklist)
 * is skipped the same way when the backend's own compaction prompt already gets it
 * (`bakesResumeGuidance`: an OpenCode server running the bot's compaction plugin,
 * which cannot see this instruction and so cannot skip a duplicate itself). The F2 closing-section directive
 * (per-locale, may carry a language directive) is appended LAST when present,
 * because it tells the model to write nothing after its end marker.
 */
export function buildCompactionInstruction(input: {
  bakesSummaryGuidance: boolean;
  summaryGuidance: string;
  bakesResumeGuidance: boolean;
  resumeGuidance: string;
  closingSectionInstruction?: string;
}): string | undefined {
  const parts: string[] = [];
  if (!input.bakesSummaryGuidance) parts.push(input.summaryGuidance);
  const resume = input.bakesResumeGuidance ? '' : input.resumeGuidance.trim();
  if (resume) parts.push(resume);
  const closing = input.closingSectionInstruction?.trim();
  if (closing) parts.push(closing);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Digit-group separator for a rendered context-token count. A NARROW NO-BREAK
 * SPACE (U+202F), not a comma or a period: both of those are DECIMAL separators
 * in some of the bot's 12 locales, so `314,150` reads as one number in an English
 * topic and as `314.15` in a German one. A space is unambiguous everywhere, and
 * no-break keeps the figure from wrapping mid-number in a Telegram bubble.
 */
const tokenCountGroupSeparator = ' ';

/**
 * @description Render a context-token count for the compaction completion
 * message ("314 150 → 12 883 tokens"): digits grouped in threes.
 *
 * Deliberately NOT `Number.toLocaleString()` — that formats for the HOST's
 * locale, not the topic's, so the same count would render differently depending
 * on the machine the bot happens to run on. This is fixed and testable instead.
 */
export function formatTokenCount(count: number): string {
  return Math.trunc(count)
    .toString()
    // Insert the separator at every position that has a multiple of three digits
    // left to run, i.e. between groups only — never before the first digit.
    .replace(/\B(?=(\d{3})+(?!\d))/g, tokenCountGroupSeparator);
}

/**
 * FIXED (English, locale-independent) sentinel markers the closing section is
 * wrapped in. Sentinels — not a markdown heading — because the two backends
 * generate very different summary formats (OpenCode's `## Goals/…` template vs
 * Claude Code's freeform numbered recap), so a heading match is unreliable while
 * exact markers are backend-agnostic. They are stripped before a summary is
 * posted ({@link stripCompactionSectionMarkers}). The per-locale instruction pins
 * these exact strings, so changing them means changing the instruction wording in
 * lockstep.
 */
export const compactionClosingStartMarker = '<<<WHERE_WE_STOPPED>>>';
export const compactionClosingEndMarker = '<<<END_WHERE_WE_STOPPED>>>';

/** What a summary line can be besides prose: the machine scaffolding of the three sections. */
export type CompactionScaffoldingKind = 'closingStart' | 'closingEnd' | 'gapsStart' | 'gapsEnd' | 'noGaps' | 'skillsStart' | 'skillsEnd';

/** Every scaffolding token a summary may carry, with what it is: the single table every reader of a summary line goes by. */
const compactionScaffoldingTokens: ReadonlyArray<{ kind: CompactionScaffoldingKind; token: string }> = [
  { kind: 'closingStart', token: compactionClosingStartMarker },
  { kind: 'closingEnd', token: compactionClosingEndMarker },
  { kind: 'gapsStart', token: compactionGapsStartMarker },
  { kind: 'gapsEnd', token: compactionGapsEndMarker },
  { kind: 'noGaps', token: compactionNoGapsLine },
  { kind: 'skillsStart', token: compactionSkillsBlockStartMarker },
  { kind: 'skillsEnd', token: compactionSkillsBlockEndMarker },
];

/** A summary line read as scaffolding: which kind it opens with and the prose after it on the same line. */
export interface ParsedCompactionSummaryLine {
  /** `null`: the line is prose (the other field is the line itself). */
  kind: CompactionScaffoldingKind | null;
  rest: string;
}

/**
 * @description Read ONE summary line: the scaffolding token it opens with (leading blanks allowed) and the prose after it,
 * which a model may put on the same line and which must survive. The one place the tokens are matched, so the summary the
 * bot reads whole ({@link formatCompactionSummaryForTopic}) and the one a backend streams tail by tail
 * (`streamedCompactionSummary.ts`) can never disagree on what is scaffolding. The «none» line takes an optional period
 * and nothing else glued to it (`NO_INSTRUCTION_GAPSFOO` is prose).
 */
export function parseCompactionSummaryLine(line: string): ParsedCompactionSummaryLine {
  const body = line.trimStart();
  for (const { kind, token } of compactionScaffoldingTokens) {
    if (!body.startsWith(token)) continue;
    const afterToken = body.slice(token.length);
    const afterNoGapsPeriod = kind === 'noGaps' && afterToken.startsWith('.') ? afterToken.slice(1) : afterToken;
    if (kind === 'noGaps' && afterNoGapsPeriod !== '' && !/^\s/.test(afterNoGapsPeriod)) continue;
    return { kind, rest: afterNoGapsPeriod.trimStart() };
  }
  return { kind: null, rest: line };
}

/**
 * @description Whether a streamed FRAGMENT of a line (no newline yet) could still turn out to be a scaffolding line: it is
 * blank so far, a prefix of a token, or already opens with one (its prose, if any, is still to come). The stream display
 * holds such a fragment back and shows any other one at once, so a half marker never reaches the topic and an ordinary
 * last line is never held back waiting for a newline that may not come.
 */
export function checkCouldBecomeCompactionScaffoldingLine(fragment: string): boolean {
  const body = fragment.trimStart();
  if (body === '') return true;
  return compactionScaffoldingTokens.some(({ token }) => token.startsWith(body) || body.startsWith(token));
}

/** Reads a summary a line at a time and says what of each line the topic shows. */
export interface CompactionSummaryLineFilter {
  /** The lines to show for `line`: none (scaffolding), the line itself (prose), or the header and the line that opens a section. */
  pushLine(line: string): string[];
  /**
   * Whether the filter is inside the loaded-skills block: every line there is hidden, so a streamed line not finished yet
   * must wait for its newline — shown in part, the rest of it would go out unfiltered.
   */
  checkIsInHiddenBlock(): boolean;
}

/**
 * @description The skill name a line of the loaded-skills block holds: the line trimmed, with one leading list bullet
 * (`- `, `* `) and surrounding backticks dropped (models add them despite the guidance); `''` for a blank line; `null` for
 * a line that is no name — one with blanks inside, one over `maxNameLength`, or one of the block's own markers.
 * Self-contained (it reads nothing outside its parameters) because the OpenCode plugin embeds its source.
 */
export function readSkillsBlockLineName(line: string, startMarker: string, endMarker: string, maxNameLength: number): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return '';
  const unbulleted = trimmed.startsWith('- ') || trimmed.startsWith('* ') ? trimmed.slice(2).trim() : trimmed;
  const name = unbulleted.length > 2 && unbulleted.startsWith('`') && unbulleted.endsWith('`') ? unbulleted.slice(1, -1) : unbulleted;
  if (name === '' || name === startMarker || name === endMarker || name.length > maxNameLength || /\s/.test(name)) return null;
  return name;
}

/**
 * @description The skill names of a summary's loaded-skills block — the LAST complete pair of `startMarker` / `endMarker`
 * lines — in the order written, de-duplicated; `null` when the summary has no complete block. A marker counts only ALONE on
 * its line, as the guidance asks: a summary that quotes the instruction in prose holds no block. A line that is no name
 * ({@link readSkillsBlockLineName}) is skipped. Self-contained (it calls only {@link readSkillsBlockLineName}) because the
 * OpenCode plugin embeds the source of both; {@link parseCompactionLoadedSkills} is the bot's own entry.
 */
export function parseSkillsBlock(summaryText: string, startMarker: string, endMarker: string, maxNameLength: number): string[] | null {
  const lines = summaryText.split(/\r?\n/);
  let endIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === endMarker) {
      endIndex = index;
      break;
    }
  }
  if (endIndex < 0) return null;
  let startIndex = -1;
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === startMarker) {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) return null;
  const names: string[] = [];
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const name = readSkillsBlockLineName(lines[index], startMarker, endMarker, maxNameLength);
    if (name !== null && name !== '' && !names.includes(name)) names.push(name);
  }
  return names;
}

/** @description The skills a compaction summary's block names ({@link parseSkillsBlock} with the summary's own markers). */
export function parseCompactionLoadedSkills(summaryText: string): string[] | null {
  return parseSkillsBlock(summaryText, compactionSkillsBlockStartMarker, compactionSkillsBlockEndMarker, compactionSkillsBlockMaxNameLength);
}

/** @description Whether a line can sit inside the loaded-skills block: a name or a blank ({@link readSkillsBlockLineName}). */
function checkIsSkillsBlockLine(line: string): boolean {
  return readSkillsBlockLineName(line, compactionSkillsBlockStartMarker, compactionSkillsBlockEndMarker, compactionSkillsBlockMaxNameLength) !== null;
}

/**
 * @description The line filter of a summary shown in the topic. Scaffolding goes: the markers of the three sections and the
 * «none» line. The self-review section gets `gapsHeader` where its first line is — it reads as the proposals it is, not as
 * more next steps beside the numbered checklist right after it — and a section with no first line (the none line, only
 * blanks) leaves no header, no marker and no trace. Prose on a marker's own line is kept.
 *
 * The loaded-skills block goes WHOLE — its names too, which are for the machine (the checklist names the skills for the
 * person) — unlike the other two sections, whose content is genuine prose. A line that is no name ends a block whose end
 * marker never came, so a model that forgets the marker hides nothing but the names.
 */
export function createCompactionSummaryLineFilter(gapsHeader: string): CompactionSummaryLineFilter {
  /** The start marker was read and no line of the section has come yet: the header waits for one. */
  let isSectionOpening = false;
  /** Inside the loaded-skills block: its lines are hidden. */
  let isInSkillsBlock = false;
  const showProse = (line: string): string[] => {
    if (!isSectionOpening) return [line];
    if (line.trim() === '') return [];
    isSectionOpening = false;
    return [gapsHeader, line];
  };
  return {
    pushLine(line: string): string[] {
      const { kind, rest } = parseCompactionSummaryLine(line);
      if (isInSkillsBlock) {
        if (kind === 'skillsEnd') {
          isInSkillsBlock = false;
          return rest.trim() === '' ? [] : showProse(rest);
        }
        if (kind === null && checkIsSkillsBlockLine(line)) return [];
        isInSkillsBlock = false;
      }
      // What follows the start marker on its own line is the block's content too.
      if (kind === 'skillsStart') {
        isInSkillsBlock = true;
        return [];
      }
      if (kind === null) return showProse(line);
      if (kind === 'gapsStart') isSectionOpening = true;
      // The end of a section that never had a line, and the none line, close it without a header.
      if (kind === 'gapsEnd' || kind === 'noGaps') isSectionOpening = false;
      return rest.trim() === '' ? [] : showProse(rest);
    },
    checkIsInHiddenBlock(): boolean {
      return isInSkillsBlock;
    },
  };
}

/**
 * @description The full compaction summary as the bot posts it to the topic: the scaffolding lines removed ({@link
 * createCompactionSummaryLineFilter}), every line of prose kept — including the closing and self-review sections the markers
 * wrap, which are genuine content — the loaded-skills block removed whole, and the self-review section under `gapsHeader`.
 *
 * A marker sitting ALONE on its line takes the whole line with it, so the summary is not left with a blank gap where it
 * stood; a marker the model happened to put AHEAD of real prose on one line loses only the marker, never the prose.
 */
export function formatCompactionSummaryForTopic(summaryText: string, gapsHeader: string): string {
  const filter = createCompactionSummaryLineFilter(gapsHeader);
  return summaryText.split(/\r?\n/).flatMap((line) => filter.pushLine(line)).join('\n').trim();
}

/** The self-review section of a summary read so far: whether its end marker has come, and what it says. */
export interface ParsedCompactionInstructionGaps {
  /** Both marker lines have been read: the section is over, whatever it holds. */
  isComplete: boolean;
  /** The section's text, `null` while it is unfinished or when it is empty or only the none line. */
  text: string | null;
}

/**
 * @description The self-review section of a compaction summary — the text between the LAST pair of
 * {@link compactionGapsStartMarker} / {@link compactionGapsEndMarker} lines, trimmed. `isComplete` is false when the summary
 * has no complete pair (a stream that has not reached the end marker yet); `text` is `null` when the section is empty or
 * holds only {@link compactionNoGapsLine} (the agent found nothing, so nothing is posted). A marker counts only ALONE on its
 * line, as the guidance asks: a summary that quotes the instruction in prose must not be mistaken for the section. The
 * last pair wins: a model that restates its section after a first attempt means the later one.
 */
export function parseCompactionInstructionGaps(summaryText: string): ParsedCompactionInstructionGaps {
  const unfinished: ParsedCompactionInstructionGaps = { isComplete: false, text: null };
  const lines = summaryText.split(/\r?\n/);
  let endIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === compactionGapsEndMarker) { endIndex = index; break; }
  }
  if (endIndex < 0) return unfinished;
  let startIndex = -1;
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === compactionGapsStartMarker) { startIndex = index; break; }
  }
  if (startIndex < 0) return unfinished;
  const section = lines.slice(startIndex + 1, endIndex).join('\n').trim();
  const isNone = section === '' || section.replace(/[.\s]+$/, '').toUpperCase() === compactionNoGapsLine;
  return { isComplete: true, text: isNone ? null : section };
}

/** The section's text alone ({@link parseCompactionInstructionGaps}): `null` for an unfinished, empty or «none» section. */
export function extractCompactionInstructionGaps(summaryText: string): string | null {
  return parseCompactionInstructionGaps(summaryText).text;
}

/**
 * @description Should the bot post the FULL compaction summary into the topic?
 *
 * Three independent reasons not to, kept in one testable rule rather than spread
 * across the call sites:
 *  - the per-topic `/compact_summary` setting is off;
 *  - the backend STREAMS its own summary into the topic already
 *    (`streamsCompactionSummary` — OpenCode's `summarize` produces a real
 *    assistant message), so the bot posting one too would duplicate it;
 *  - the route is not a real, awaited compaction: `forwardToAgent` hands
 *    `/compact` to a TUI that renders its own result and gives the bot no
 *    completion signal, and `notSupported` never compacts at all — in both cases
 *    there is no summary of ours to post.
 */
export function checkShouldPostCompactionSummary(input: {
  isEnabled: boolean;
  streamsOwnSummary: boolean;
  route: CompactCommandRoute;
}): boolean {
  if (!input.isEnabled) return false;
  if (input.streamsOwnSummary) return false;
  return input.route === 'adapterCompact';
}

/**
 * @description Should the bot read the SELF-REVIEW section ({@link compactionGapsGuidance}) of a compaction summary and
 * post it into the topic as a message of its own — the part of the summary that is shown even when the full summary is
 * hidden?
 *
 * No when:
 *  - the section is switched off for the topic (`/compact_self_review`);
 *  - the route is not a real, awaited compaction (the same reason as {@link checkShouldPostCompactionSummary}: the bot
 *    has no summary to read);
 *  - the compaction is the bot's own AND the full summary is shown: the section is inside it (posted by the bot, or
 *    streamed by the backend), so a second message would repeat it;
 *  - the compaction is the backend's own and it STREAMS its summary (`streamsOwnSummary`): the stream is the one channel for
 *    it — shown whole with `/compact_summary` on, taken apart by the bot with it off (`streamedCompactionSummary.ts`) — so
 *    reading the summary here would post the section twice.
 *
 * Otherwise yes: a compaction the bot issued with the summary hidden — on EVERY backend, a streaming one included: there the
 * stream is dropped, and the bot reads the section after the compaction, so it lands in order (the notice, then the
 * section, then a re-asked question) instead of whenever the last tail arrives — and a compaction the CLI ran by itself on
 * a backend that does not stream: nobody posts that summary, whatever `/compact_summary` says.
 */
export function checkShouldPostInstructionGaps(input: {
  /** `/compact_self_review`: off ⇒ the agent is not asked for the section and nothing of it is posted. */
  isEnabled: boolean;
  isSummaryEnabled: boolean;
  streamsOwnSummary: boolean;
  /** Whether the bot issued this compaction (`/compact`, the agent's `compact_conversation`, the idle one). */
  isBotIssued: boolean;
  route: CompactCommandRoute;
}): boolean {
  if (!input.isEnabled) return false;
  if (input.route !== 'adapterCompact') return false;
  if (input.isBotIssued) return !input.isSummaryEnabled;
  return !input.streamsOwnSummary;
}

/**
 * @description Should the bot announce that a compaction is STARTING (the notice
 * that goes out BEFORE the wait, for the triggers the operator is present for)?
 *
 * Two reasons not to:
 *  - the route is not one the bot awaits: `forwardToAgent` hands `/compact` to a TUI
 *    that renders its own progress, and `notSupported` never compacts at all;
 *  - no session is live. The compaction seam's first guard is exactly that, so
 *    announcing here would be a promise the very next message retracts — `/compact`
 *    in a bound topic whose agent was never started hits precisely that, and before
 *    the notice moved ahead of the wait the operator only ever saw the refusal.
 *
 * Deliberately NOT the same rule as the COMPLETION report, which needs no liveness
 * input: it is reached only after a compaction really succeeded.
 */
export function checkShouldAnnounceCompactionStart(input: {
  route: CompactCommandRoute;
  isSessionActive: boolean;
}): boolean {
  return input.route === 'adapterCompact' && input.isSessionActive;
}

/** The three parts of an idle-compaction report, each its OWN topic message. */
export interface IdleCompactionNoticeParts {
  /** The short idle notice. */
  notice: string | null;
  /** The full summary, posted as its own message(s). */
  summary: string | null;
  /** The self-review section alone, posted when the full summary is not ({@link checkShouldPostInstructionGaps}). */
  instructionGaps: string | null;
  /** The re-asked pending question — always LAST, so its buttons stay reachable. */
  question: string | null;
}

/**
 * @description Compose an idle-compaction report as SEPARATE parts in the §1.4
 * order: notice → summary → self-review section → re-asked question.
 *
 * Splitting what used to be one joined message is the point: the re-asked
 * question carries inline option buttons, and gluing it behind a full summary
 * would bury those buttons under a wall of text (and the summary alone can
 * outgrow a single Telegram message).
 *
 * The notice is the one short line on its own. It used to carry the summary's
 * "Where we stopped" block whenever the full summary was off, which still made
 * every idle compaction a paragraph; with the summary off the operator now gets
 * the line alone, and the block reaches the topic only inside the full summary.
 */
export function buildIdleCompactionNoticeParts(input: {
  /** The idle notice text, or `null` when the compaction FAILED (nothing to announce). */
  noticeText: string | null;
  summary: string | null;
  instructionGaps: string | null;
  /** The re-asked question's rendered text, or `null` when none was pending. */
  questionText: string | null;
}): IdleCompactionNoticeParts {
  return {
    notice: input.noticeText && input.noticeText.length > 0 ? input.noticeText : null,
    summary: input.summary && input.summary.length > 0 ? input.summary : null,
    instructionGaps: input.instructionGaps && input.instructionGaps.length > 0 ? input.instructionGaps : null,
    question: input.questionText && input.questionText.length > 0 ? input.questionText : null,
  };
}
