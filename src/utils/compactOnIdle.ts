/**
 * @description Pure decision + text helpers for the compact-on-idle feature and
 * the shared closing-section instruction/extraction (plan
 * `agent/tasks/actual/2026-09-14-self-compact-and-compact-on-idle.md`, F2).
 *
 * Kept out of `bot.ts` (which cannot be imported by tests — its module-scope
 * `parseEnv()` exits without a bot token) so every branch is unit-testable,
 * mirroring `getCompactCommandRoute` in `compactCommandRoute.ts`.
 */

/**
 * Idle interval before an untouched, idle agent session is auto-compacted (F2).
 * Chosen to fire just inside the ~1h Anthropic extended prompt-cache window, so
 * the compaction reads the still-warm cached prefix cheaply. No env override in
 * v1 — a locked plan decision.
 */
export const idleCompactMs = 55 * 60 * 1000;

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
}): IdleCompactionArmDecision {
  if (input.lastActivityAt <= 0) return { delayMs: idleCompactMs, kind: 'fullWindow' };
  const remainingMs = idleCompactMs - (input.now - input.lastActivityAt);
  // Clamped: a backward clock step makes `lastActivityAt` future-dated, and the
  // remainder must never exceed the window it is a remainder of.
  if (remainingMs > 0) return { delayMs: Math.min(remainingMs, idleCompactMs), kind: 'remainder' };
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
  if (threadOverride !== undefined) return threadOverride;
  return globalDefault ?? true;
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
 * @description The idle-fire guard, re-checked at the moment the idle timer
 * fires: compact only when the feature is enabled for the thread, a session is
 * actually active, it is NOT busy for a real running turn (a pending question is
 * NOT such a reason — see {@link checkIsBusyForRealTurn}; D1), the per-thread
 * user-latch is NOT already spent (D2 — after a fire it stays latched until the
 * next genuine USER message re-arms it, so idle compaction runs at most once per
 * user-active period), AND at least one agent turn has completed since the last
 * compaction (otherwise there is nothing new to compress and we skip silently —
 * a locked plan decision).
 */
export function checkShouldFireIdleCompaction(input: {
  isEnabled: boolean;
  isSessionActive: boolean;
  isBusyForRealTurn: boolean;
  isLatched: boolean;
  hasCompletedTurnSinceCompaction: boolean;
}): boolean {
  return (
    input.isEnabled &&
    input.isSessionActive &&
    !input.isBusyForRealTurn &&
    !input.isLatched &&
    input.hasCompletedTurnSinceCompaction
  );
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
 * @description Compose the per-invocation compaction instruction the bot passes
 * to a backend (D3 + F2 closing section). The general summary guidance is
 * appended ONLY when the backend does NOT already bake it into its own prompt —
 * OpenCode bakes it in the fork (`bakesSummaryGuidance: true`) so re-sending it
 * would duplicate the text, whereas the Claude backends have no bot-controlled
 * prompt and must receive it every time. The F2 closing-section directive
 * (per-locale, may carry a language directive) is appended when present. Returns
 * `undefined` when nothing needs appending, keeping a plain `/compact`
 * byte-identical to before for OpenCode.
 */
export function buildCompactionInstruction(input: {
  bakesSummaryGuidance: boolean;
  summaryGuidance: string;
  closingSectionInstruction?: string;
}): string | undefined {
  const parts: string[] = [];
  if (!input.bakesSummaryGuidance) parts.push(input.summaryGuidance);
  const closing = input.closingSectionInstruction?.trim();
  if (closing) parts.push(closing);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * FIXED (English, locale-independent) sentinel markers the closing section is
 * wrapped in. Sentinels — not a markdown heading — because the two backends
 * generate very different summary formats (OpenCode's `## Goals/…` template vs
 * Claude Code's freeform numbered recap), so a heading match is unreliable while
 * exact markers are backend-agnostic and let the extractor stop before any
 * trailing boilerplate. The per-locale instruction pins these exact strings, so
 * changing them means changing the instruction wording in lockstep.
 */
export const compactionClosingStartMarker = '<<<WHERE_WE_STOPPED>>>';
export const compactionClosingEndMarker = '<<<END_WHERE_WE_STOPPED>>>';

/**
 * @description Pull the closing-section prose out of a generated compaction
 * summary: return the text between {@link compactionClosingStartMarker} and
 * {@link compactionClosingEndMarker} (or to end-of-text when the end marker is
 * missing), trimmed, with any stray marker lines removed. Returns `null` when
 * the start marker is absent or the section is empty — the caller then omits the
 * closing block from the notice (graceful degradation), never posting an empty
 * or marker-only block.
 */
export function extractCompactionClosingSection(summaryText: string): string | null {
  if (!summaryText) return null;
  const startIndex = summaryText.indexOf(compactionClosingStartMarker);
  if (startIndex === -1) return null;
  const afterStart = startIndex + compactionClosingStartMarker.length;
  const endIndex = summaryText.indexOf(compactionClosingEndMarker, afterStart);
  const raw = endIndex === -1 ? summaryText.slice(afterStart) : summaryText.slice(afterStart, endIndex);
  // Defensive: drop any residual marker fragments the model echoed inside.
  const text = raw
    .split(compactionClosingStartMarker).join('')
    .split(compactionClosingEndMarker).join('')
    .trim();
  return text.length > 0 ? text : null;
}
