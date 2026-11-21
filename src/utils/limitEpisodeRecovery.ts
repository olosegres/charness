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

import * as crypto from 'crypto';
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
  return findParkedTerminalError(Buffer.from(tailText, 'utf8'), 0)?.text ?? null;
}

/** The error a session is parked on, and where its terminal frame ends in the session's `stdout.jsonl`. */
export interface ParkedTerminalError {
  text: string;
  /**
   * The byte offset in the log right after the error's `result` line (its newline included): WHERE the episode is. Frames
   * appended after it — the reply to the bot's boot `mcp_status`, a rate-limit event — move the log's size and mtime, never this.
   */
  endOffset: number;
  /**
   * {@link getLimitEpisodeLineStamp} of that whole `result` line — WHICH turn it ended: the line carries the turn's own `uuid`,
   * `duration_ms` and `session_id`. The log is deleted and written anew whenever the agent process starts or exits, so a
   * resumed process can hit the same limit text at the same byte offset (the same start frames, the bot's fixed «continue»
   * prompt, a clock-only reset that repeats every day); the offset and the text alone would take that new limit for the old one.
   */
  stamp: string;
}

const newlineByte = 0x0a;

/**
 * @description {@link getLastTerminalErrorText} with the position of the error: `tail` is the log's tail as read (`tailStartOffset`
 * is where it starts in the log), split on its newline bytes — a newline is never part of a multi-byte UTF-8 character, so the
 * offsets are exact even when the tail starts in the middle of one (that torn first line is skipped).
 */
export function findParkedTerminalError(tail: Buffer, tailStartOffset: number): ParkedTerminalError | null {
  let parked: ParkedTerminalError | null = null;
  let lineStart = 0;
  while (lineStart < tail.length) {
    const newlineAt = tail.indexOf(newlineByte, lineStart);
    const lineEnd = newlineAt === -1 ? tail.length : newlineAt + 1;
    const line = tail.subarray(lineStart, newlineAt === -1 ? tail.length : newlineAt);
    const parsed = parseStreamJsonLine(line.toString('utf8'));
    lineStart = lineEnd;
    if (!parsed) continue; // blank, or the tail's torn first line
    for (const action of classifyClaudeStreamMessage(parsed)) {
      if (action.kind === 'turnEnd') {
        // A later healthy turn CLEARS the verdict — the session recovered.
        parked = action.isError && action.errorText !== null
          ? { text: action.errorText, endOffset: tailStartOffset + lineEnd, stamp: getLimitEpisodeLineStamp(line) }
          : null;
      } else if (checkIsSessionActivity(action)) {
        parked = null;
      }
    }
  }
  return parked;
}

/** How many hex digits of the `result` line's hash an episode marker keeps: enough to tell two turns apart. */
const lineStampLength = 16;

/**
 * @description The stamp of a parked error's whole `result` line (its bytes, the newline left out) an episode marker keeps beside
 * its offset: a hash — the line's text, the error included, is not kept.
 */
export function getLimitEpisodeLineStamp(resultLine: Buffer | string): string {
  return crypto.createHash('sha256').update(resultLine).digest('hex').slice(0, lineStampLength);
}

/**
 * @description The marker that records an episode as handled: the log's identity now, and — when the log is parked on an error —
 * that error's place and the stamp of its `result` line, which is what later boots compare ({@link decideLimitEpisodeRecovery}).
 */
export function buildLimitEpisodeMarker(log: Pick<LimitEpisodeMarker, 'sizeBytes' | 'mtimeMs'>, parked: ParkedTerminalError | null): LimitEpisodeMarker {
  return {
    sizeBytes: log.sizeBytes,
    mtimeMs: log.mtimeMs,
    ...(parked !== null ? { errorEndOffset: parked.endOffset, errorStamp: parked.stamp } : {}),
  };
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

/** One content block of a transcript message (only text blocks carry the error). */
interface TranscriptContentBlock {
  type?: string;
  text?: string;
}

/** One line of a Claude transcript, as far as {@link getParkedErrorWrittenAtMs} reads it — untrusted, checked field by field. */
interface TranscriptApiErrorEntry {
  isApiErrorMessage?: boolean;
  timestamp?: string;
  message?: { content?: string | TranscriptContentBlock[] };
}

/** @description The text blocks of a transcript entry's message, joined. */
function getTranscriptEntryText(entry: TranscriptApiErrorEntry): string {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('');
}

/**
 * @description When the parked error was written, read off the Claude transcript tail: the `timestamp` of the LAST
 * API-error entry (`isApiErrorMessage`) whose text is the error's. `null` when there is no such entry or its timestamp
 * does not parse — the caller falls back to the stdout log's mtime, which anything appended later (a background
 * sub-agent, an ambient frame) moves.
 */
export function getParkedErrorWrittenAtMs(transcriptTail: string, errorText: string): number | null {
  let writtenAtMs: number | null = null;
  const expectedText = errorText.trim();
  for (const line of transcriptTail.split('\n')) {
    if (!line.includes('"isApiErrorMessage"')) continue;
    let entry: TranscriptApiErrorEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the tail's torn first line
    }
    if (entry.isApiErrorMessage !== true || getTranscriptEntryText(entry).trim() !== expectedText) continue;
    const parsedMs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    writtenAtMs = Number.isNaN(parsedMs) ? null : parsedMs;
  }
  return writtenAtMs;
}

export type LimitEpisodeDecision =
  /** Arm the limit wait through the normal live-error path. */
  | { action: 'arm'; cls: AgentApiErrorClass }
  /** Nothing to do; `reason` is for the boot log only. */
  | { action: 'skip'; reason: 'noError' | 'notUsageLimit' | 'stale' | 'alreadyArmed' | 'alreadyHandled' };

/**
 * @description Whether this thread's trailing error is the one a previous boot (or a settled wait) already acted on, so re-arming
 * would resurrect a wait that was already settled — skipped by «⏭ Skip once», by a user takeover, by the retry giving up, or armed by
 * the recovery of an earlier boot. This matters on every code change, because hot mode reloads the bot.
 *
 * The episode is the parked error ITSELF: the same `result` line (`errorStamp`, the stamp of the whole line — its turn's `uuid`,
 * `duration_ms`, `session_id` and the error) at the same place in the log (`errorEndOffset`). Frames written after it that are no
 * activity of the session — above all the reply to the `mcp_status` request every boot sends an adopted session, and rate-limit
 * events — change the log's size and mtime but not the episode; compared on those, every restart re-armed the last parked error. A
 * genuinely NEW trailing error is a new line — at a new offset, or, in a log a new process wrote anew, at the same offset with the
 * same text but another turn's fields — so it still arms; a stamp missing on either side counts as another line. A marker written
 * before the episode was kept (no `errorEndOffset`), or a log read without its error's place, is compared the old way: both the
 * log's size and its mtime.
 */
function checkIsSameHandledEpisode(
  handled: LimitEpisodeMarker | undefined,
  current: { log: LimitEpisodeMarker; errorText: string | null; errorEndOffset: number | null | undefined; errorStamp: string | null | undefined },
): boolean {
  if (!handled) return false;
  if (handled.errorEndOffset !== undefined && current.errorEndOffset !== undefined && current.errorEndOffset !== null && current.errorText !== null) {
    return handled.errorEndOffset === current.errorEndOffset
      && handled.errorStamp !== undefined && current.errorStamp !== undefined && current.errorStamp !== null
      && handled.errorStamp === current.errorStamp;
  }
  return handled.sizeBytes === current.log.sizeBytes && handled.mtimeMs === current.log.mtimeMs;
}

/**
 * @description Decide whether a session's trailing error should re-arm a limit
 * wait at boot. Deliberately strict — every guard exists to keep a boot from
 * pushing a surprise prompt into a topic:
 *  - only when no persisted retry record already covers the thread (that one is
 *    re-armed by the normal restore path — arming twice would double-notice);
 *  - only when the parked error is not the episode a previous boot, or a settled
 *    wait, already handled ({@link checkIsSameHandledEpisode});
 *  - only the `usageLimit` class (a transient error is long past by restart time,
 *    and an `auth` error needs a human, not a wait);
 *  - only when the ERROR is younger than {@link limitEpisodeMaxAgeMs} — its own time
 *    (`errorWrittenAtMs`) when known: the log's mtime moves with every frame written
 *    after it, a boot's own `mcp_status` reply included, so it would keep an old error
 *    young for ever.
 * The reset the error names is resolved against the moment it was WRITTEN —
 * `errorWrittenAtMs` (the transcript's own timestamp, {@link getParkedErrorWrittenAtMs}),
 * else the log's mtime — not against the boot: a clock-only reset (`resets 10:50pm`)
 * resolves to its NEXT occurrence, so read at a boot after 22:50 it became TOMORROW
 * 22:50 and a window that had already reset was announced as exhausted for another
 * day. A `resetAt` that is in the past by now is a window that is over: the bot
 * resumes at once without announcing a limit.
 */
export function decideLimitEpisodeRecovery(input: {
  errorText: string | null;
  /** Where the parked error's frame ends in the log ({@link findParkedTerminalError}); absent → the episode is told by the log's identity. */
  errorEndOffset?: number | null;
  /** The stamp of that error's whole `result` line ({@link ParkedTerminalError.stamp}); with `errorEndOffset`, WHICH turn's error it is. */
  errorStamp?: string | null;
  /** When the error was written, from the transcript; absent → the log's mtime. */
  errorWrittenAtMs?: number | null;
  /** Identity (size + mtime) of the session's `stdout.jsonl` right now. */
  log: LimitEpisodeMarker;
  /** The marker of the episode a previous boot or a settled wait handled, if any ({@link buildLimitEpisodeMarker}). */
  handled?: LimitEpisodeMarker;
  now: number;
  hasArmedRetry: boolean;
}): LimitEpisodeDecision {
  if (input.hasArmedRetry) return { action: 'skip', reason: 'alreadyArmed' };
  if (checkIsSameHandledEpisode(input.handled, { log: input.log, errorText: input.errorText, errorEndOffset: input.errorEndOffset, errorStamp: input.errorStamp })) {
    return { action: 'skip', reason: 'alreadyHandled' };
  }
  if (!input.errorText) return { action: 'skip', reason: 'noError' };
  if (input.now - (input.errorWrittenAtMs ?? input.log.mtimeMs) > limitEpisodeMaxAgeMs) return { action: 'skip', reason: 'stale' };
  const cls = classifyAgentApiError(input.errorText, input.errorWrittenAtMs ?? input.log.mtimeMs);
  if (cls?.kind !== 'usageLimit') return { action: 'skip', reason: 'notUsageLimit' };
  return { action: 'arm', cls };
}
