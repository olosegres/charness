/**
 * @description Reasoning-effort level catalogs and per-backend helpers.
 *
 * The bot's `/effort` command and both adapters share this module so the
 * level vocabularies stay in one place and stay easy to unit-test.
 *
 * **Two vocabularies, on purpose.**
 *
 * - **Claude** has a native `/effort` slash command with a small fixed set
 *   (`low medium high xhigh max auto ultracode`). claude itself clamps an
 *   unsupported level for the current model down to the nearest supported
 *   one, so the bot offers the canonical set unconditionally — the adapter
 *   has no way to read claude's live model.
 * - **OpenCode** encodes reasoning effort as the `variants` map on a model
 *   in `provider.models.<m>.variants` (e.g. anthropic ships `high`/`max`,
 *   openai ships `none…xhigh`). The legal set therefore depends on which
 *   model the thread is currently using and cannot be hard-coded — the
 *   OpenCode adapter reads it live from `GET /config/providers` and applies
 *   the chosen variant per-prompt. See `openCodeAdapter.ts`.
 */

import type { SessionKey } from './sessionKey';
import type { AgentAdapter } from './types';

// ── Claude (canonical set) ──────────────────────────────────────────────────

/**
 * @description Claude `/effort` slash-command levels, in the order they're
 * shown to the user. Verified against `claude 2.1.158`.
 *
 * `auto` resets back to claude's per-model default; `ultracode` is a heavy
 * coding-focused profile. Both are valid arguments to the TUI slash command.
 */
export const claudeEffortLevels = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
  'ultracode',
] as const;

export type ClaudeEffortLevel = (typeof claudeEffortLevels)[number];

/**
 * @description The code fallback for the reasoning effort of a bot-started session — the last link of the chain
 * that decides what a session runs with, first that exists wins:
 *
 * 1. the topic's own `/effort` pick (the per-thread pref);
 * 2. the platform's default (Jira: `jira.json`'s effort, `sessionLaunchDefaults.ts`);
 * 3. the instance default — `defaultEffort` in `settings.json`, set from `/effort` in General
 *    ({@link getInstanceDefaultEffort});
 * 4. this constant.
 *
 * An explicit pick always wins and is never overwritten; the default is a derived fallback, never persisted as a
 * pref. The only real levels are `low`/`medium`/`high`/`xhigh`/`max` (there is no `xlarge`). OpenCode clamps the
 * result to the resolved model's variants via {@link clampEffortToAvailable}; Claude clamps unsupported levels itself.
 */
export const defaultEffortLevel: ClaudeEffortLevel = 'medium';

/**
 * @description Where the instance default effort comes from (`settings.json`). `null` = nothing set. The
 * composition root registers the file-backed reader; a module that merely needs the level never touches the file.
 */
export type InstanceDefaultEffortReader = () => ClaudeEffortLevel | null;

let instanceDefaultEffortReader: InstanceDefaultEffortReader = () => null;

/** @description Register where {@link getInstanceDefaultEffort} reads the instance default from (the bot, once, at start-up). */
export function setInstanceDefaultEffortReader(reader: InstanceDefaultEffortReader): void {
  instanceDefaultEffortReader = reader;
}

/**
 * @description The reasoning effort of every topic that has no `/effort` pick of its own: the instance default
 * from `settings.json`, else the code fallback {@link defaultEffortLevel}. Read per call (the reader caches by the
 * file's stamp), so a hand edit applies to the next session start without a restart.
 */
export function getInstanceDefaultEffort(): ClaudeEffortLevel {
  return instanceDefaultEffortReader() ?? defaultEffortLevel;
}

/**
 * @name ThreadEffortView
 * @description What `/status`, the banner, the ready notice and `/effort` show for a thread.
 */
export interface ThreadEffortView {
  /** The level the live session really uses; with no live session (or an unknown one), the level the next start will use. */
  level: string;
  /** Set only when the next start will use a DIFFERENT level than `level` (the default changed under a running session). */
  nextStartLevel: string | null;
}

/**
 * @description The effort a thread shows: the level its RUNNING session uses (a General change never reaches a
 * running session — it applies from the next start), else the level the next start will use; plus the next start's
 * level when it differs, so the screen can say "xhigh (medium from the next start)". `null` for a backend with no
 * effort concept (no `getEffortState`) and for a thread whose model is known to offer no levels — then there is
 * nothing to show.
 */
export function getThreadEffortView(adapter: Pick<AgentAdapter, 'getEffortState'>, key: SessionKey): ThreadEffortView | null {
  const state = adapter.getEffortState?.(key);
  if (!state) return null;
  const level = state.running ?? state.nextStart;
  return { level, nextStartLevel: level === state.nextStart ? null : state.nextStart };
}

/**
 * @description The level a backend that offers only `levels` runs for `level`: the level itself when offered, else
 * the nearest it has ({@link clampEffortToAvailable}); the level itself when the clamp has nothing to say (`auto`,
 * which sends no variant, or a model with no variants).
 */
export function getEffortAmongLevels(level: string, levels: readonly string[]): string {
  return levels.includes(level) ? level : (clampEffortToAvailable(level, levels) ?? level);
}

/**
 * @description Internal rank order shared by {@link clampEffortToAvailable}.
 * Spans both vocabularies (`none` is OpenCode-only) low→high.
 */
const effortRankOrder = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The Claude levels that have no place in {@link effortRankOrder}; see {@link clampEffortToAvailable}. */
const autoEffortLevel = 'auto';
const ultracodeEffortLevel = 'ultracode';

/**
 * @description Clamp a desired effort level to what a model actually offers.
 *
 * OpenCode effort is a model VARIANT and not every model ships `xhigh`
 * (e.g. opus-4-5 / sonnet-4-6 stop at high/max); sending an unknown variant
 * 400s. This picks the best legal variant:
 *
 * - keep only `available` entries we know how to rank ("known"); none known
 *   → return null (the model has no usable effort concept).
 * - if `desired` is itself available → return it.
 * - else return the highest known variant with rank ≤ rank(desired); if none
 *   are below, return the lowest known variant (closest above).
 *
 * The two Claude-only levels have no rank, and "nothing is below them" must not
 * mean the lowest variant (a General default of `ultracode` would run every
 * OpenCode topic at its weakest):
 *
 * - `ultracode` (the heaviest profile) → the model's HIGHEST known variant.
 * - `auto` (claude's own per-model default) → `null`: no variant is sent.
 *
 * Claude clamps itself, so it never calls this.
 */
export function clampEffortToAvailable(
  desired: string,
  available: readonly string[],
): string | null {
  if (desired === autoEffortLevel) return null;
  const known = available.filter((level) =>
    (effortRankOrder as readonly string[]).includes(level),
  );
  if (known.length === 0) return null;
  if (known.includes(desired)) return desired;

  // Rank lookup widens the typed tuple to readonly string[] (the sanctioned
  // typed-array cast) rather than narrowing the argument; -1 for non-members.
  const rankOf = (level: string): number =>
    (effortRankOrder as readonly string[]).indexOf(level);
  // `ultracode` ranks above every variant, so "the highest one at or below it" is the model's top variant.
  const desiredRank = desired === ultracodeEffortLevel ? effortRankOrder.length : rankOf(desired);

  let bestBelow: string | null = null;
  let lowestKnown: string | null = null;
  for (const level of known) {
    if (lowestKnown === null || rankOf(level) < rankOf(lowestKnown)) {
      lowestKnown = level;
    }
    if (rankOf(level) <= desiredRank) {
      if (bestBelow === null || rankOf(level) > rankOf(bestBelow)) {
        bestBelow = level;
      }
    }
  }
  return bestBelow ?? lowestKnown;
}

/**
 * @description Canonical Claude effort levels. Returns a fresh mutable copy
 * so callers can safely sort/filter without mutating the frozen
 * module-level constant.
 */
export function getClaudeAvailableLevels(): string[] {
  return [...claudeEffortLevels];
}

/**
 * @description Whether `level` is a Claude effort level the TUI accepts.
 * Used by `/effort <bad>` rejection before we type anything into the pane.
 */
export function checkIsClaudeEffortLevel(level: string): level is ClaudeEffortLevel {
  return (claudeEffortLevels as readonly string[]).includes(level);
}
