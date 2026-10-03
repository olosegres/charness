/**
 * @description Pure layer behind the boot recovery of a usage/session-limit
 * episode that ENDED BEFORE the bot restarted.
 *
 * An ARMED retry survives a restart on its own (`state.json` `apiRetries`,
 * re-armed after reattach). An UNRECOGNISED limit error leaves nothing behind —
 * so a topic whose agent died on a limit before the detector understood that
 * wording just sits there, and a bot update alone does not resume it. This module
 * reads the evidence the json-stream Claude backend leaves on disk (the terminal
 * `result` frame at the end of its `stdout.jsonl`) and decides whether the bot
 * should arm the limit wait itself.
 *
 * V1 IS JSON-STREAM ONLY, by evidence availability: the tmux-scrape backend keeps
 * its history only in a tmux pane (already repainted by adopt time) and OpenCode's
 * error lives in a transient SSE event, so neither has a comparable on-disk tail
 * to re-read. Those backends recover the normal way — the next live error fires
 * the detector.
 *
 * Only the decisions live here; the fs read and the `handleApiError` call stay in
 * `bot.ts` (the apiErrorRetry pure-layer / manager split).
 */

import { classifyAgentApiError } from '../apiErrorRetry';
import { classifyClaudeStreamMessage, parseStreamJsonLine, type ClaudeStreamAction } from './claudeStreamJson';
import type { AgentApiErrorClass, LimitEpisodeMarker } from '../types';

/**
 * How much of a session's `stdout.jsonl` to read when hunting the last terminal
 * frame. The log holds a whole session's events and can reach hundreds of MB, so
 * only the tail is read — the terminal `result` frame is by definition the last
 * thing written. A torn first line is simply skipped by the NDJSON parser.
 */
export const limitEpisodeTailMaxBytes = 64 * 1024;

/**
 * Max age of the stdout log for its trailing error to still count as "the episode
 * the topic is stuck on". Older than this and the topic has moved on (or the limit
 * window is long expired), so resurrecting it would push an unexpected prompt into
 * a quiet topic.
 */
export const limitEpisodeMaxAgeMs = 12 * 60 * 60 * 1000;

/**
 * @description The error text the session is PARKED on, read out of a stdout
 * tail: the last terminal `result` frame's error, or `null` when the tail ends on
 * a healthy turn, holds no terminal frame, or shows the session moving on after
 * the error. Reuses the adapter's own NDJSON parse + message classifier, so "what
 * counts as a terminal error and where its text lives" has exactly one definition.
 *
 * Anything real written AFTER the error — the echo of a message sent to the
 * session, the agent's text, thinking or tool frames — clears the verdict, though
 * the turn it belongs to has no terminal frame yet. That is what a limit resume
 * leaves in the log: the bot's own "continue" nudge and the work on it. A topic
 * with that tail is not stuck on the old error, and re-arming it at a restart
 * in the middle of that turn would resume the same episode a second time.
 *
 * Only the PARENT session's frames count. A terminal `result` ends the parent
 * turn, so the one thing that can still write after it without a resume is a
 * background sub-agent finishing its own work (`parent_tool_use_id` set); a
 * resume always starts with the parent's own frames (the nudge's echo first), so
 * leaving the sub-agent's out loses nothing and keeps a parked topic parked.
 */
export function getLastTerminalErrorText(tailText: string): string | null {
  let lastErrorText: string | null = null;
  for (const line of tailText.split('\n')) {
    const parsed = parseStreamJsonLine(line);
    if (!parsed) continue; // blank, or the tail's torn first line
    for (const action of classifyClaudeStreamMessage(parsed)) {
      if (action.kind === 'turnEnd') {
        // A later healthy turn CLEARS the verdict — the session recovered.
        lastErrorText = action.isError ? action.errorText : null;
      } else if (checkIsSessionActivity(action)) {
        lastErrorText = null;
      }
    }
  }
  return lastErrorText;
}

/** Frames that only a running PARENT session writes (not the ambient rate-limit /
 *  status ones, and not a sub-agent's — see {@link getLastTerminalErrorText}). */
function checkIsSessionActivity(action: ClaudeStreamAction): boolean {
  if (action.kind === 'userEcho') return true;
  if (action.kind === 'textDelta' || action.kind === 'thinkingDelta' || action.kind === 'toolUse' || action.kind === 'toolResult') {
    return !action.isSubagent;
  }
  return false;
}

export type LimitEpisodeDecision =
  /** Arm the limit wait through the normal live-error path. */
  | { action: 'arm'; cls: AgentApiErrorClass }
  /** Nothing to do; `reason` is for the boot log only. */
  | { action: 'skip'; reason: 'noError' | 'notUsageLimit' | 'stale' | 'alreadyArmed' | 'alreadyHandled' };

/**
 * @description Whether this thread's trailing error is the one a previous boot
 * already acted on: the log is byte-for-byte the same file, at the same mtime, as
 * when the marker was written. Nothing has happened since, so re-arming would
 * resurrect a wait that was already settled — skipped by «⏭ Skip once», by a user
 * takeover, or by the retry giving up. Both fields must match; any real turn
 * appends frames and changes them, so a genuinely NEW trailing error still arms.
 * This matters on every code change, because hot mode reloads the bot.
 */
function checkIsSameHandledLog(handled: LimitEpisodeMarker | undefined, log: LimitEpisodeMarker): boolean {
  if (!handled) return false;
  return handled.sizeBytes === log.sizeBytes && handled.mtimeMs === log.mtimeMs;
}

/**
 * @description Decide whether a session's trailing error should re-arm a limit
 * wait at boot. Deliberately strict — every guard exists to keep a boot from
 * pushing a surprise prompt into a topic:
 *  - only when no persisted retry record already covers the thread (that one is
 *    re-armed by the normal restore path — arming twice would double-notice);
 *  - only when the log CHANGED since the episode a previous boot already handled
 *    ({@link checkIsSameHandledLog});
 *  - only the `usageLimit` class (a transient error is long past by restart time,
 *    and an `auth` error needs a human, not a wait);
 *  - only when the log is younger than {@link limitEpisodeMaxAgeMs}.
 * A `resetAt` already in the past needs no special case: the retry plan clamps a
 * negative delay to zero and the boot arming turns that into one prompt catch-up.
 */
export function decideLimitEpisodeRecovery(input: {
  errorText: string | null;
  /** Identity (size + mtime) of the session's `stdout.jsonl` right now. */
  log: LimitEpisodeMarker;
  /** Identity recorded when a previous boot armed from this log, if any. */
  handled?: LimitEpisodeMarker;
  now: number;
  hasArmedRetry: boolean;
}): LimitEpisodeDecision {
  if (input.hasArmedRetry) return { action: 'skip', reason: 'alreadyArmed' };
  if (checkIsSameHandledLog(input.handled, input.log)) return { action: 'skip', reason: 'alreadyHandled' };
  if (!input.errorText) return { action: 'skip', reason: 'noError' };
  if (input.now - input.log.mtimeMs > limitEpisodeMaxAgeMs) return { action: 'skip', reason: 'stale' };
  const cls = classifyAgentApiError(input.errorText, input.now);
  if (cls?.kind !== 'usageLimit') return { action: 'skip', reason: 'notUsageLimit' };
  return { action: 'arm', cls };
}
