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
 * receive a real prompt, so give it a minute of grace first.
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
 *    overdue topic would start an LLM compaction turn and post its notice in the
 *    same instant. Spreading them over ~1–11 minutes keeps the backlog orderly,
 *    and deriving the offset from the thread key keeps it deterministic (hence
 *    testable) instead of random.
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
 * An overdue thread is compacted even though its prompt cache has long gone
 * cold. The 55-minute interval exists to make the compaction TURN itself cheap
 * against a warm cache, but the payoff of compacting is that every SUBSEQUENT
 * turn in that session reads a small context instead of a huge one — clearly
 * worth one uncached read, whereas skipping it leaves the session permanently
 * bloated.
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
  return {
    delayMs: compactIdleOverdueMinDelayMs + (getStableHash(input.threadKeyString) % compactIdleOverdueSpreadMs),
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
 * @description Whether the process is WORKING at the idle fire (L-D2): a real
 * running turn ({@link checkIsBusyForRealTurn} — a pending question excuses the
 * turn, D1) OR background work the question never excuses (a background task,
 * input not yet taken in, a compaction in flight). The two are read apart so a
 * question pending over a running background task still reads as working: the
 * D1 reject-compact-re-ask would otherwise end in a stop that kills the task.
 */
export function checkIsWorkingAtIdle(input: {
  isBusy: boolean;
  hasPendingQuestion: boolean;
  hasBackgroundWork: boolean;
}): boolean {
  return checkIsBusyForRealTurn(input) || input.hasBackgroundWork;
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
}

/**
 * @description The idle-fire decision, taken the moment the idle timer fires
 * (lifecycle plan L3). Nothing happens to a session that is not there or is
 * WORKING (L-D2: a real running turn, a background task, input not yet taken in,
 * a compaction in flight — a pending interactive question is NOT work, see
 * {@link checkIsBusyForRealTurn}; D1); the next activity re-arms the timer.
 *
 * The compaction runs only when the feature is enabled for the thread, the
 * per-thread user-latch is NOT already spent (D2 — after a fire it stays latched
 * until the next genuine USER message re-arms it, so idle compaction runs at most
 * once per user-active period), at least one agent turn has completed since the
 * last compaction (otherwise there is nothing new to compress), and no
 * usage-limit wait is armed (L-D6: a compaction turn would hit the limit).
 *
 * The STOP happens whether or not the compaction runs (L-D1: a resume restores
 * the full history, so a stopped process loses nothing) — on a backend that can
 * be suspended; the tmux TUI and OpenCode stay (L-D8).
 */
export function getIdleFireDecision(input: {
  isSessionActive: boolean;
  isWorking: boolean;
  isEnabled: boolean;
  isLatched: boolean;
  hasCompletedTurnSinceCompaction: boolean;
  isLimitWaitArmed: boolean;
  canSuspend: boolean;
}): IdleFireDecision {
  const notIdleReasons = [
    !input.isSessionActive && 'no active session',
    input.isWorking && 'working',
  ].filter((reason): reason is string => typeof reason === 'string');
  if (notIdleReasons.length > 0) {
    return { shouldCompact: false, compactionSkipReasons: notIdleReasons, shouldSuspend: false, suspendSkipReasons: notIdleReasons };
  }
  const compactionSkipReasons = [
    !input.isEnabled && 'disabled',
    input.isLatched && 'latched (D2)',
    !input.hasCompletedTurnSinceCompaction && 'nothing to compress',
    input.isLimitWaitArmed && 'a usage-limit wait is armed (L-D6)',
  ].filter((reason): reason is string => typeof reason === 'string');
  return {
    shouldCompact: compactionSkipReasons.length === 0,
    compactionSkipReasons,
    shouldSuspend: input.canSuspend,
    suspendSkipReasons: input.canSuspend ? [] : ['the backend is not suspended'],
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
 * @description The loaded-skills guidance. A skill is loaded on demand mid-session (a tool call whose
 * result carries its instructions), so — unlike CLAUDE.md / AGENTS.md — nothing
 * reloads it after a compaction: the summary drops its text and the fresh
 * session keeps working without the procedure it was following. Naming the
 * skills and saying in plain words that they must be loaded again is the only
 * way the continuing session learns to re-invoke them. It travels with
 * {@link compactionChecklistGuidance} as {@link compactionResumeGuidance}.
 */
export const compactionSkillsGuidance =
  'List every skill that was loaded (invoked) during this session by its exact name, and state explicitly, in plain words, that the continuing session MUST load each of these skills again and follow it before resuming the work: a skill\'s instructions are not carried over by this summary, so without reloading them the fresh session works without them. If no skill was loaded, omit this.';

/**
 * @description The "what to do next" checklist every compaction summary ends with.
 * Item 1 is the skills reload (the skills named exactly, so the continuing session
 * cannot skip it or paraphrase a name into one that does not load); the rest are
 * the next steps the summary already records, in order — never invented ones. With
 * a closing section requested, the list is that section's last part, right before
 * its end marker, so "write nothing after the end marker" still holds; otherwise it
 * ends the summary. A code constant for the same reason as
 * {@link compactionSummaryGuidance}: one text for every path, no locale in it. It is
 * ONE line of printable ASCII with no double quote or backslash, because the
 * `PreCompact` hook matches it as a fixed string in the raw JSON it reads on stdin.
 */
export const compactionChecklistGuidance =
  'End the summary with a numbered checklist (1., 2., 3., one short item per line) of what the continuing session does next, as the very LAST thing in it. Item 1 is \'load these skills\' followed by the exact name of every skill that was loaded (invoked) in this session, never translated or shortened; if none was loaded, leave that item out. The other items are the next steps this summary already records, in order: invent no new steps. If you are also asked to write a closing section between two marker lines, the checklist is the last part of that section, right before its end marker.';

/**
 * FIXED (English, locale-independent) sentinel markers the agent-mistakes section is wrapped in, and the one line
 * the section holds when there were none. Sentinels for the same reason as {@link compactionClosingStartMarker}:
 * the backends write very different summary formats, so exact marker lines are the one backend-agnostic way to lift
 * the section out of a summary ({@link extractCompactionInstructionGaps}). The guidance below pins these exact strings.
 */
export const compactionGapsStartMarker = '<<<INSTRUCTION_GAPS>>>';
export const compactionGapsEndMarker = '<<<END_INSTRUCTION_GAPS>>>';
export const compactionNoGapsLine = 'NO_INSTRUCTION_GAPS';

/**
 * @description The agent-mistakes guidance: the summary gets a section of this session's mistakes — the repeated ones
 * above all — that a change to the agent's standing instructions could have prevented, each with the concrete change and
 * where it goes. The BOT lifts the section out of the summary and posts it to the topic even when the full summary is
 * hidden ({@link checkShouldPostInstructionGaps}), so the person sees what to fix in the instructions without opening a
 * summary. It is written in the language the conversation was held in (the hook and the plugin that carry this text are
 * shared by every topic, so no locale can be baked in), PROPOSES and never edits (the person decides), and sits before the
 * checklist and any closing section, which stay last. Travels with {@link compactionSkillsGuidance} and
 * {@link compactionChecklistGuidance} as {@link compactionResumeGuidance} (ahead of them), so ONE line of printable ASCII with no double
 * quote or backslash, for the `PreCompact` hook's fixed-string match.
 */
export const compactionGapsGuidance =
  `List the mistakes the agent made in this session, especially REPEATED ones, that a change to its standing instructions (rules, skills, CLAUDE.md / AGENTS.md) could prevent: for each, the mistake, then the concrete instruction change that would prevent it and where that change would go. Put that list in its own section wrapped EXACTLY between a line containing only ${compactionGapsStartMarker} and a line containing only ${compactionGapsEndMarker}, placed before the numbered checklist and before any closing section, and write it in the language the user used in this conversation. If there were no such mistakes, write only the single line ${compactionNoGapsLine} between those two marker lines. The continuing session must only PROPOSE these changes to the user and wait for approval: it must never write or change instructions on its own.`;

/**
 * @description What the continuing session needs from EVERY compaction summary — the
 * agent-mistakes section, the loaded skills and the next-steps checklist — as the one text each path carries:
 * a bot-issued compaction in its instruction ({@link buildCompactionInstruction}),
 * and each backend's own overflow compaction through a bot-installed hook — Claude's
 * `PreCompact` hook (`claudeCompactHook.ts`, which also matches on this exact text to
 * skip a compaction that already carries it) and OpenCode's compaction plugin
 * (`openCodeCompactPlugin.ts`). The checklist stays LAST: each sentence says where it goes in the summary, so the order
 * of the sentences is free — and the agent-mistakes sentence goes AHEAD of the older text, which stays a contiguous
 * substring: a process started before the section existed keeps its hook (adopted across hot reloads, hooks are read at
 * start), and that hook skips a compaction by finding the OLD text (`${skills} ${checklist}`); written between the two
 * sentences, the new one would break that match and the model would read the skills and the checklist twice.
 */
export const compactionResumeGuidance = `${compactionGapsGuidance} ${compactionSkillsGuidance} ${compactionChecklistGuidance}`;

/**
 * @description Compose the per-invocation compaction instruction the bot passes
 * to a backend (D3 + the resume guidance + F2 closing section). The general summary
 * guidance is appended ONLY when the backend does NOT already bake it into its
 * own prompt — OpenCode bakes it in the fork (`bakesSummaryGuidance: true`) so
 * re-sending it would duplicate the text, whereas the Claude backends have no
 * bot-controlled prompt and must receive it every time. The resume guidance
 * ({@link compactionResumeGuidance}: the agent-mistakes section, the loaded skills and the next-steps checklist)
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

/** What a summary line can be besides prose: the machine scaffolding of the two sections. */
export type CompactionScaffoldingKind = 'closingStart' | 'closingEnd' | 'gapsStart' | 'gapsEnd' | 'noGaps';

/** Every scaffolding token a summary may carry, with what it is: the single table every reader of a summary line goes by. */
const compactionScaffoldingTokens: ReadonlyArray<{ kind: CompactionScaffoldingKind; token: string }> = [
  { kind: 'closingStart', token: compactionClosingStartMarker },
  { kind: 'closingEnd', token: compactionClosingEndMarker },
  { kind: 'gapsStart', token: compactionGapsStartMarker },
  { kind: 'gapsEnd', token: compactionGapsEndMarker },
  { kind: 'noGaps', token: compactionNoGapsLine },
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
}

/**
 * @description The line filter of a summary shown in the topic. Scaffolding goes: the markers of both sections and the
 * «none» line. The agent-mistakes section gets `gapsHeader` where its first line is — it reads as the proposals it is, not as
 * more next steps beside the numbered checklist right after it — and a section with no first line (the none line, only
 * blanks) leaves no header, no marker and no trace. Prose on a marker's own line is kept.
 */
export function createCompactionSummaryLineFilter(gapsHeader: string): CompactionSummaryLineFilter {
  /** The start marker was read and no line of the section has come yet: the header waits for one. */
  let isSectionOpening = false;
  const showProse = (line: string): string[] => {
    if (!isSectionOpening) return [line];
    if (line.trim() === '') return [];
    isSectionOpening = false;
    return [gapsHeader, line];
  };
  return {
    pushLine(line: string): string[] {
      const { kind, rest } = parseCompactionSummaryLine(line);
      if (kind === null) return showProse(line);
      if (kind === 'gapsStart') isSectionOpening = true;
      // The end of a section that never had a line, and the none line, close it without a header.
      if (kind === 'gapsEnd' || kind === 'noGaps') isSectionOpening = false;
      return rest.trim() === '' ? [] : showProse(rest);
    },
  };
}

/**
 * @description The full compaction summary as the bot posts it to the topic: the scaffolding lines removed ({@link
 * createCompactionSummaryLineFilter}), every line of prose kept — including the sections the markers wrap, which are
 * genuine content — and the agent-mistakes section under `gapsHeader`.
 *
 * A marker sitting ALONE on its line takes the whole line with it, so the summary is not left with a blank gap where it
 * stood; a marker the model happened to put AHEAD of real prose on one line loses only the marker, never the prose.
 */
export function formatCompactionSummaryForTopic(summaryText: string, gapsHeader: string): string {
  const filter = createCompactionSummaryLineFilter(gapsHeader);
  return summaryText.split(/\r?\n/).flatMap((line) => filter.pushLine(line)).join('\n').trim();
}

/** The agent-mistakes section of a summary read so far: whether its end marker has come, and what it says. */
export interface ParsedCompactionInstructionGaps {
  /** Both marker lines have been read: the section is over, whatever it holds. */
  isComplete: boolean;
  /** The section's text, `null` while it is unfinished or when it is empty or only the none line. */
  text: string | null;
}

/**
 * @description The agent-mistakes section of a compaction summary — the text between the LAST pair of
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
 * @description Should the bot read the AGENT-MISTAKES section ({@link compactionGapsGuidance}) of a compaction summary and
 * post it into the topic as a message of its own — the part of the summary that is shown even when the full summary is
 * hidden?
 *
 * No when:
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
  isSummaryEnabled: boolean;
  streamsOwnSummary: boolean;
  /** Whether the bot issued this compaction (`/compact`, the agent's `compact_conversation`, the idle one). */
  isBotIssued: boolean;
  route: CompactCommandRoute;
}): boolean {
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
  /** The agent-mistakes section alone, posted when the full summary is not ({@link checkShouldPostInstructionGaps}). */
  instructionGaps: string | null;
  /** The re-asked pending question — always LAST, so its buttons stay reachable. */
  question: string | null;
}

/**
 * @description Compose an idle-compaction report as SEPARATE parts in the §1.4
 * order: notice → summary → agent-mistakes section → re-asked question.
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
