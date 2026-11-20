/**
 * @description Unit tests for {@link ../utils/limitEpisodeRecovery} — reading the
 * terminal error out of a json-stream session's `stdout.jsonl` tail, and deciding
 * whether a limit episode that ended BEFORE the bot restarted should be re-armed.
 *
 * The lines below are real stream-json shapes. A provider limit is not inducible on
 * demand, so this table is the load-bearing proof for the boot-recovery path.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildLimitEpisodeMarker,
  findParkedTerminalError,
  getLastTerminalErrorText,
  getLimitEpisodeErrorStamp,
  getParkedErrorWrittenAtMs,
  decideLimitEpisodeRecovery,
  limitEpisodeMaxAgeMs,
} from '../utils/limitEpisodeRecovery';
import type { LimitEpisodeMarker } from '../types';

const now = Date.parse('2026-09-24T12:00:00.000Z');
const liveLimitText = "You've hit your session limit · resets 10:50pm (UTC)";

/** The live `stdout.jsonl` identity (size + mtime) a decision is taken against. */
function buildLog(mtimeMs: number, sizeBytes = 4096): LimitEpisodeMarker {
  return { sizeBytes, mtimeMs };
}

/** A terminal `result` frame, error or not. */
function buildResultLine(isError: boolean, text: string): string {
  return JSON.stringify(
    isError ? { type: 'result', is_error: true, result: text } : { type: 'result', is_error: false, result: text },
  );
}

const assistantLine = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'working on it' }] },
});

test('tail: the last terminal error frame wins', () => {
  const tail = [assistantLine, buildResultLine(true, liveLimitText), ''].join('\n');
  assert.equal(getLastTerminalErrorText(tail), liveLimitText);
});

test('tail: reads `api_error_status` in preference to `result` (the adapter\'s own rule)', () => {
  const line = JSON.stringify({ type: 'result', is_error: true, api_error_status: liveLimitText, result: 'x' });
  assert.equal(getLastTerminalErrorText(line), liveLimitText);
});

test('tail: a LATER healthy turn clears the verdict — the session recovered', () => {
  const tail = [
    buildResultLine(true, liveLimitText),
    assistantLine,
    buildResultLine(false, 'all done'),
  ].join('\n');
  assert.equal(getLastTerminalErrorText(tail), null);
});

/** The `--replay-user-messages` echo of a message the bot (or the operator) wrote. */
const userEchoLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'continue' } });
const textDeltaLine = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'picking up where I stopped' } },
});
const thinkingDeltaLine = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'let me look' } },
});
const toolUseLine = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] },
});
const toolResultLine = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
});
const rateLimitEventLine = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 1 } });

test('tail: anything real AFTER the error means the session was resumed — the bot\'s own "continue" nudge, and the turn it started, which has no terminal frame yet', () => {
  // After a limit resume the nudge's echo and the agent's work are all that follows the old error: the topic is not
  // parked on it. Read as parked, a restart in the middle of that turn would arm the same episode a second time.
  for (const [label, frames] of [
    ['the echo of the nudge', [userEchoLine]],
    ['the echo and the agent\'s text', [userEchoLine, textDeltaLine]],
    ['the agent\'s text', [textDeltaLine]],
    ['the agent\'s thinking', [thinkingDeltaLine]],
    ['a tool call', [toolUseLine]],
    ['a tool result', [toolResultLine]],
  ] as const) {
    assert.equal(getLastTerminalErrorText([buildResultLine(true, liveLimitText), ...frames].join('\n')), null, label);
  }
});

test('tail: a limit error AFTER the resumption wins again — the nudge hit the limit once more', () => {
  const secondLimitText = "You've hit your weekly limit · resets Mon 9:00am (UTC)";
  const tail = [buildResultLine(true, liveLimitText), userEchoLine, buildResultLine(true, secondLimitText)].join('\n');
  assert.equal(getLastTerminalErrorText(tail), secondLimitText);
});

test('tail: ambient frames after the error (a rate-limit event) are not activity — the topic is still parked on it', () => {
  assert.equal(getLastTerminalErrorText([buildResultLine(true, liveLimitText), rateLimitEventLine].join('\n')), liveLimitText);
});

test('tail: a sub-agent\'s frames after the error are not activity — a background sub-agent finishing its work is no resume', () => {
  // The parent turn ended on the error; only a sub-agent still running in the background can write after it without
  // anyone resuming the topic. Counting its frames would read the parked topic as resumed and lose its resume.
  const subagentTextDeltaLine = JSON.stringify({
    type: 'stream_event',
    parent_tool_use_id: 'toolu_task1',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'still summarising' } },
  });
  const subagentThinkingDeltaLine = JSON.stringify({
    type: 'stream_event',
    parent_tool_use_id: 'toolu_task1',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'nearly there' } },
  });
  const subagentToolUseLine = JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: 'toolu_task1',
    message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }] },
  });
  const subagentToolResultLine = JSON.stringify({
    type: 'user',
    parent_tool_use_id: 'toolu_task1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] },
  });
  for (const [label, frames] of [
    ['its text', [subagentTextDeltaLine]],
    ['its thinking', [subagentThinkingDeltaLine]],
    ['its tool call', [subagentToolUseLine]],
    ['its tool result', [subagentToolResultLine]],
    ['all of them', [subagentTextDeltaLine, subagentThinkingDeltaLine, subagentToolUseLine, subagentToolResultLine]],
  ] as const) {
    assert.equal(getLastTerminalErrorText([buildResultLine(true, liveLimitText), ...frames].join('\n')), liveLimitText, label);
  }
});

test('tail: a torn first line (the tail cut mid-JSON) is skipped, not fatal', () => {
  const tail = ['ge":{"content":[{"type":"text"', buildResultLine(true, liveLimitText)].join('\n');
  assert.equal(getLastTerminalErrorText(tail), liveLimitText);
});

test('tail: no terminal frame at all → null', () => {
  assert.equal(getLastTerminalErrorText([assistantLine, assistantLine].join('\n')), null);
  assert.equal(getLastTerminalErrorText(''), null);
});

test('with no armed retry on record, a topic resumed after the error is left alone — the log is the only evidence it was resumed', () => {
  // A limit resume that has run its course leaves no saved retry behind, so at the next boot only the log can say the
  // topic moved on. A restart in the middle of the nudge's turn must not arm the old episode a second time.
  const resumedMidTurn = [buildResultLine(true, liveLimitText), userEchoLine, textDeltaLine].join('\n');
  assert.deepEqual(
    decideLimitEpisodeRecovery({ errorText: getLastTerminalErrorText(resumedMidTurn), log: buildLog(now - 5_000), now, hasArmedRetry: false }),
    { action: 'skip', reason: 'noError' },
  );
  // The other side: a restart before the nudge reached the log (written to the live session, not echoed yet) still
  // finds the topic parked on the error, and recovers it — the resume is not lost. (A nudge buffered behind a session
  // START is a different case: the fresh spawn lays the host dir out anew, so the new log holds no error to find — the
  // saved retry record, kept while the nudge waits in the startup buffer, is what resumes that one.)
  assert.equal(
    decideLimitEpisodeRecovery({ errorText: getLastTerminalErrorText(buildResultLine(true, liveLimitText)), log: buildLog(now - 5_000), now, hasArmedRetry: false }).action,
    'arm',
  );
});

test('decide: a recent usage-limit error with nothing armed → arm', () => {
  const decision = decideLimitEpisodeRecovery({
    errorText: liveLimitText,
    log: buildLog(now - 60_000),
    now,
    hasArmedRetry: false,
  });
  assert.equal(decision.action, 'arm');
  assert.equal(decision.action === 'arm' ? decision.cls.kind : null, 'usageLimit');
});

test('decide: a thread whose retry is already armed is left alone (no double notice)', () => {
  assert.deepEqual(
    decideLimitEpisodeRecovery({ errorText: liveLimitText, log: buildLog(now - 60_000), now, hasArmedRetry: true }),
    { action: 'skip', reason: 'alreadyArmed' },
  );
});

test('decide: an ANCIENT log is not resurrected', () => {
  assert.deepEqual(
    decideLimitEpisodeRecovery({
      errorText: liveLimitText,
      log: buildLog(now - limitEpisodeMaxAgeMs - 1),
      now,
      hasArmedRetry: false,
    }),
    { action: 'skip', reason: 'stale' },
  );
  // Exactly at the boundary still counts as recent.
  assert.equal(
    decideLimitEpisodeRecovery({
      errorText: liveLimitText,
      log: buildLog(now - limitEpisodeMaxAgeMs),
      now,
      hasArmedRetry: false,
    }).action,
    'arm',
  );
});

test('decide: only the usageLimit class is recovered — transient and auth are not', () => {
  for (const errorText of [
    'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    'Please run /login to continue',
  ]) {
    assert.deepEqual(
      decideLimitEpisodeRecovery({ errorText, log: buildLog(now - 60_000), now, hasArmedRetry: false }),
      { action: 'skip', reason: 'notUsageLimit' },
      errorText,
    );
  }
});

test('decide: a healthy tail (no error text) → skip', () => {
  assert.deepEqual(
    decideLimitEpisodeRecovery({ errorText: null, log: buildLog(now - 60_000), now, hasArmedRetry: false }),
    { action: 'skip', reason: 'noError' },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
//  The handled-episode marker: recover an episode at most ONCE
// ─────────────────────────────────────────────────────────────────────────────
//
// «⏭ Skip once», a user takeover and a give-up all clear the armed record while
// leaving the SAME trailing error in the log — and hot mode reloads the bot on
// every code change, so without the marker each reload resurrected the settled
// wait. The marker names the parked error's place in the log (its frame's end offset and a stamp of its text); a marker
// without it — written before it was kept — is compared on the log's size + mtime, as it always was.

test('decide: no marker yet → arm (the first boot after the episode)', () => {
  const decision = decideLimitEpisodeRecovery({
    errorText: liveLimitText,
    log: buildLog(now - 60_000),
    handled: undefined,
    now,
    hasArmedRetry: false,
  });
  assert.equal(decision.action, 'arm');
});

test('decide: a marker matching the LIVE log → skip (a reload must not resurrect a settled wait)', () => {
  const log = buildLog(now - 60_000);
  assert.deepEqual(
    decideLimitEpisodeRecovery({ errorText: liveLimitText, log, handled: { ...log }, now, hasArmedRetry: false }),
    { action: 'skip', reason: 'alreadyHandled' },
  );
});

test('decide: a CHANGED log → arm again (either field is enough — new bytes mean a new episode)', () => {
  const handled = buildLog(now - 3_600_000, 4096);
  // Appended frames: bigger file, newer mtime.
  assert.equal(
    decideLimitEpisodeRecovery({
      errorText: liveLimitText,
      log: buildLog(now - 60_000, 8192),
      handled,
      now,
      hasArmedRetry: false,
    }).action,
    'arm',
  );
  // Same size, newer mtime → still a change; the guard needs BOTH to match.
  assert.equal(
    decideLimitEpisodeRecovery({
      errorText: liveLimitText,
      log: buildLog(now - 60_000, 4096),
      handled,
      now,
      hasArmedRetry: false,
    }).action,
    'arm',
  );
  // Same mtime, different size (a truncate-and-reseed) → also a change.
  assert.equal(
    decideLimitEpisodeRecovery({
      errorText: liveLimitText,
      log: buildLog(handled.mtimeMs, 512),
      handled,
      now,
      hasArmedRetry: false,
    }).action,
    'arm',
  );
});

test('decide: a reset time already in the past still arms — the delay clamp handles it', () => {
  // Nothing special is needed for a past reset: `getRetryPlan` clamps the negative
  // delay to zero, so the bot resumes promptly instead of skipping the episode.
  const pastResetNow = Date.parse('2026-09-24T23:30:00.000Z');
  const decision = decideLimitEpisodeRecovery({
    errorText: liveLimitText,
    log: buildLog(pastResetNow - 60_000),
    now: pastResetNow,
    hasArmedRetry: false,
  });
  assert.equal(decision.action, 'arm');
});

// The reset a recovered error names is resolved against the moment the error was
// WRITTEN (the log's mtime — nothing real follows it), not against the boot. A
// clock-only reset ("resets 10:50pm") resolves to its NEXT occurrence: read at a
// boot after 22:50 it became tomorrow 22:50, so a window that had already reset
// was announced as "usage limit reached — will auto-resume after reset" for
// another day, and the parked topic waited for it.
test('decide: the reset is read relative to the error, so a window that reset before the boot is not pushed to the next day', () => {
  const errorAt = Date.parse('2026-09-24T22:00:00.000Z');
  const bootAt = Date.parse('2026-09-24T23:30:00.000Z');
  const decision = decideLimitEpisodeRecovery({ errorText: liveLimitText, log: buildLog(errorAt), now: bootAt, hasArmedRetry: false });
  assert.equal(decision.action, 'arm');
  assert.equal(
    decision.action === 'arm' && decision.cls.kind === 'usageLimit' ? decision.cls.resetAt : null,
    Date.parse('2026-09-24T22:50:00.000Z'),
    'the 10:50pm reset of the error written at 22:00 — already past at the boot, so the resume is immediate',
  );
});

test('decide: a recovered reset still ahead keeps its time', () => {
  const errorAt = Date.parse('2026-09-24T22:00:00.000Z');
  const bootAt = Date.parse('2026-09-24T22:20:00.000Z');
  const decision = decideLimitEpisodeRecovery({ errorText: liveLimitText, log: buildLog(errorAt), now: bootAt, hasArmedRetry: false });
  assert.equal(decision.action === 'arm' && decision.cls.kind === 'usageLimit' ? decision.cls.resetAt : null, Date.parse('2026-09-24T22:50:00.000Z'));
});

// The log's mtime moves whenever anything is appended after the parked error — a background sub-agent finishing,
// an ambient rate-limit frame — so it can land past a clock reset and push it to the next day again. The Claude
// transcript records the API error itself, with its own `timestamp`: that is the error's time; the mtime is only
// the fallback when the transcript has no such entry.
function buildTranscriptApiErrorLine(text: string, timestampIso: string): string {
  return JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', timestamp: timestampIso, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

test('transcript: the parked error\'s time is the timestamp of the API-error entry with the same text — the last one', () => {
  const tail = [
    '{"type":"assistant","isApiErrorMessage":true,"timestamp":"2026-09-24T08:00:00.000Z","message":{"content":[{"type":"text","text":"Prompt is too long"}]}}',
    buildTranscriptApiErrorLine(liveLimitText, '2026-09-24T21:00:00.000Z'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'continue' } }),
    buildTranscriptApiErrorLine(liveLimitText, '2026-09-24T22:00:00.000Z'),
  ].join('\n');
  assert.equal(getParkedErrorWrittenAtMs(tail, liveLimitText), Date.parse('2026-09-24T22:00:00.000Z'));
});

test('transcript: no API-error entry with that text (or a torn line, a bad timestamp) → null, the mtime decides', () => {
  assert.equal(getParkedErrorWrittenAtMs(buildTranscriptApiErrorLine('Prompt is too long', '2026-09-24T22:00:00.000Z'), liveLimitText), null);
  assert.equal(getParkedErrorWrittenAtMs(`{"type":"assis\n${buildTranscriptApiErrorLine(liveLimitText, 'not a time')}`, liveLimitText), null);
  assert.equal(getParkedErrorWrittenAtMs('', liveLimitText), null);
});

test('decide: the transcript\'s error time wins over a log mtime that frames written later moved past the reset', () => {
  const errorAt = Date.parse('2026-09-24T22:00:00.000Z');
  const laterFrameAt = Date.parse('2026-09-24T23:00:00.000Z');
  const bootAt = Date.parse('2026-09-24T23:30:00.000Z');
  const decision = decideLimitEpisodeRecovery({ errorText: liveLimitText, errorWrittenAtMs: errorAt, log: buildLog(laterFrameAt), now: bootAt, hasArmedRetry: false });
  assert.equal(
    decision.action === 'arm' && decision.cls.kind === 'usageLimit' ? decision.cls.resetAt : null,
    Date.parse('2026-09-24T22:50:00.000Z'),
    'the 10:50pm reset of the error written at 22:00, though the log was last written at 23:00',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
//  The episode is the parked error itself, not the whole log
// ─────────────────────────────────────────────────────────────────────────────
//
// Every boot asks an adopted session for its `mcp_status` (the bot MCP heal), and the reply lands in `stdout.jsonl` AFTER
// the boot's recovery read it. A marker of the whole log (size + mtime) was out of date by the next boot, so every restart
// re-armed the last parked error — a limit settled long ago, announced and waited for again.

/** The control_response an adopted session writes to the `mcp_status` request of the bot's boot heal. */
const mcpStatusReplyLine = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'mcp_status_1', response: { mcpServers: [] } } });
const sessionStateLine = JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' });

/** A stdout log as the bot reads it: lines joined, each closed by its newline. */
function buildLogBytes(lines: readonly string[]): Buffer {
  return Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8');
}

/** What the boot recovery reads of `bytes`: the tail (from `tailStart`) and the log's identity. */
function readEvidence(bytes: Buffer, mtimeMs: number, tailStart = 0) {
  return { log: buildLog(mtimeMs, bytes.length), parked: findParkedTerminalError(bytes.subarray(tailStart), tailStart) };
}

test('parked error: its place is the byte offset right after its line — exact past multi-byte text, and in a tail cut mid-character', () => {
  const before = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Готово — 日本語 ✅' }] } }), assistantLine];
  const bytes = buildLogBytes([...before, buildResultLine(true, liveLimitText)]);
  assert.deepEqual(findParkedTerminalError(bytes, 0), { text: liveLimitText, endOffset: bytes.length });
  // A tail starting inside the Cyrillic text: its torn first line is skipped, the offset is still the log's.
  const tailStart = bytes.indexOf(Buffer.from('Готово', 'utf8')) + 1;
  assert.deepEqual(findParkedTerminalError(bytes.subarray(tailStart), tailStart), { text: liveLimitText, endOffset: bytes.length });
  // No trailing newline (a line still being written): the offset is the end of what was read.
  const unterminated = Buffer.from(buildResultLine(true, liveLimitText), 'utf8');
  assert.equal(findParkedTerminalError(unterminated, 100)?.endOffset, 100 + unterminated.length);
});

test('parked error: frames that are no turn — the boot\'s mcp_status reply, a session state, a rate-limit event — keep the error and its place', () => {
  const parkedBytes = buildLogBytes([assistantLine, buildResultLine(true, liveLimitText)]);
  const grown = Buffer.concat([parkedBytes, buildLogBytes([mcpStatusReplyLine, sessionStateLine, rateLimitEventLine, mcpStatusReplyLine])]);
  assert.deepEqual(findParkedTerminalError(grown, 0), { text: liveLimitText, endOffset: parkedBytes.length });
  // Activity after it still ends the episode, and a later error is a new place.
  assert.equal(findParkedTerminalError(Buffer.concat([grown, buildLogBytes([userEchoLine])]), 0), null);
  const again = Buffer.concat([grown, buildLogBytes([userEchoLine, buildResultLine(true, liveLimitText)])]);
  assert.deepEqual(findParkedTerminalError(again, 0), { text: liveLimitText, endOffset: again.length });
});

test('restarts: an episode the recovery armed is not armed again at the next boots, though each boot appends its mcp_status reply', () => {
  const bootAt = now - 10 * 60_000;
  let bytes = buildLogBytes([assistantLine, buildResultLine(true, liveLimitText)]);
  // Boot 1: the parked error is recovered and stamped — then this boot's heal appends its reply.
  const first = readEvidence(bytes, bootAt);
  const firstDecision = decideLimitEpisodeRecovery({ errorText: first.parked?.text ?? null, errorEndOffset: first.parked?.endOffset, log: first.log, now: bootAt, hasArmedRetry: false });
  assert.equal(firstDecision.action, 'arm');
  const marker = buildLimitEpisodeMarker(first.log, first.parked);
  bytes = Buffer.concat([bytes, buildLogBytes([mcpStatusReplyLine])]);
  // Boots 2..4 (the armed record gone: skipped once, given up, taken over): each finds the grown log, each appends again.
  for (let boot = 2; boot <= 4; boot += 1) {
    const evidence = readEvidence(bytes, bootAt + boot * 60_000);
    assert.notEqual(evidence.log.sizeBytes, marker.sizeBytes, 'the log did grow');
    assert.deepEqual(
      decideLimitEpisodeRecovery({ errorText: evidence.parked?.text ?? null, errorEndOffset: evidence.parked?.endOffset, log: evidence.log, handled: marker, now: bootAt + boot * 60_000, hasArmedRetry: false }),
      { action: 'skip', reason: 'alreadyHandled' },
      `boot ${boot}`,
    );
    bytes = Buffer.concat([bytes, buildLogBytes([mcpStatusReplyLine])]);
  }
  // A NEW parked error (a later turn hit a limit again) is a new episode: recovered.
  bytes = Buffer.concat([bytes, buildLogBytes([userEchoLine, buildResultLine(true, liveLimitText)])]);
  const later = readEvidence(bytes, now);
  assert.equal(decideLimitEpisodeRecovery({ errorText: later.parked?.text ?? null, errorEndOffset: later.parked?.endOffset, log: later.log, handled: marker, now, hasArmedRetry: false }).action, 'arm');
});

test('restarts: a wait settled without its resume (marker written then) stays settled across the boots\' mcp_status replies too', () => {
  // «⏭ Skip once» / a give-up mark the episode while the live log is parked on it (markLimitEpisodeSettled).
  const parked = buildLogBytes([buildResultLine(true, liveLimitText), rateLimitEventLine]);
  const marker = buildLimitEpisodeMarker(buildLog(now - 120_000, parked.length), findParkedTerminalError(parked, 0));
  const grown = Buffer.concat([parked, buildLogBytes([mcpStatusReplyLine, mcpStatusReplyLine])]);
  const evidence = readEvidence(grown, now - 1_000);
  assert.deepEqual(
    decideLimitEpisodeRecovery({ errorText: evidence.parked?.text ?? null, errorEndOffset: evidence.parked?.endOffset, log: evidence.log, handled: marker, now, hasArmedRetry: false }),
    { action: 'skip', reason: 'alreadyHandled' },
  );
});

test('marker: the parked error\'s place and text stamp beside the log\'s identity; none when the log is not parked; another text at the same place is another episode', () => {
  const log = buildLog(now - 1_000, 4096);
  assert.deepEqual(buildLimitEpisodeMarker(log, null), { sizeBytes: 4096, mtimeMs: now - 1_000 });
  const marker = buildLimitEpisodeMarker(log, { text: liveLimitText, endOffset: 2048 });
  assert.deepEqual(marker, { sizeBytes: 4096, mtimeMs: now - 1_000, errorEndOffset: 2048, errorStamp: getLimitEpisodeErrorStamp(liveLimitText) });
  assert.match(marker.errorStamp ?? '', /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(marker).includes('session limit'), 'the text itself is not kept');
  // A log truncated and reseeded by a new process may put another error at the same byte offset.
  const otherText = "You've hit your weekly limit · resets Mon 9:00am (UTC)";
  assert.equal(decideLimitEpisodeRecovery({ errorText: otherText, errorEndOffset: 2048, log: buildLog(now, 4300), handled: marker, now, hasArmedRetry: false }).action, 'arm');
  assert.equal(decideLimitEpisodeRecovery({ errorText: liveLimitText, errorEndOffset: 2048, log: buildLog(now, 4300), handled: marker, now, hasArmedRetry: false }).action, 'skip');
});

test('marker: one written before the episode was kept (no offset) is still compared on the log\'s size and mtime', () => {
  const legacy = buildLog(now - 60_000, 4096);
  assert.equal(decideLimitEpisodeRecovery({ errorText: liveLimitText, errorEndOffset: 4096, log: { ...legacy }, handled: legacy, now, hasArmedRetry: false }).action, 'skip');
  assert.equal(decideLimitEpisodeRecovery({ errorText: liveLimitText, errorEndOffset: 4000, log: buildLog(now - 1_000, 4250), handled: legacy, now, hasArmedRetry: false }).action, 'arm', 'one last time — the stamp it writes then is the new one');
});

test('decide: the 12 h age is the ERROR\'s own time when known — frames written after it (a boot\'s mcp_status reply) never keep an old error young', () => {
  const freshMtime = now - 60_000;
  assert.deepEqual(
    decideLimitEpisodeRecovery({ errorText: liveLimitText, errorWrittenAtMs: now - limitEpisodeMaxAgeMs - 1, log: buildLog(freshMtime), now, hasArmedRetry: false }),
    { action: 'skip', reason: 'stale' },
  );
  assert.equal(decideLimitEpisodeRecovery({ errorText: liveLimitText, errorWrittenAtMs: now - limitEpisodeMaxAgeMs, log: buildLog(freshMtime), now, hasArmedRetry: false }).action, 'arm');
});
