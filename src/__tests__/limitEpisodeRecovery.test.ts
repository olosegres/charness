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
  getLastTerminalErrorText,
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
  // START is a different case: the fresh spawn lays the host dir out anew, so the new log holds no error to find.)
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
// wait. Identity = size + mtime: an unchanged log means nothing has happened.

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
