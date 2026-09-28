/**
 * @description S3 typing-active decision: the native typing state persists while
 * output is streaming, the agent is busy, OR a bot-issued compaction is running,
 * and clears only when all three are false.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkShouldKeepTyping } from '../utils/typingActive';

test('typing keeps showing while output is streaming (even if the agent reads idle)', () => {
  assert.equal(checkShouldKeepTyping({ isOutputStreaming: true, isAdapterBusy: false, isCompacting: false }), true);
});

test('typing keeps showing while the agent is busy (even with nothing queued)', () => {
  assert.equal(checkShouldKeepTyping({ isOutputStreaming: false, isAdapterBusy: true, isCompacting: false }), true);
});

test('typing keeps showing while both hold', () => {
  assert.equal(checkShouldKeepTyping({ isOutputStreaming: true, isAdapterBusy: true, isCompacting: false }), true);
});

test('typing keeps showing through a compaction, with NOTHING else holding it up', () => {
  // The load-bearing case: during a compaction the other two inputs are both
  // false on at least one backend (OpenCode sets no busy flag for `summarize` and
  // nothing streams), so without this input a 43 s — or 3-minute — compaction
  // leaves the topic showing no activity at all.
  assert.equal(
    checkShouldKeepTyping({ isOutputStreaming: false, isAdapterBusy: false, isCompacting: true }),
    true,
  );
});

test('typing stops ONLY when the topic is truly drained AND idle', () => {
  assert.equal(checkShouldKeepTyping({ isOutputStreaming: false, isAdapterBusy: false, isCompacting: false }), false);
});
