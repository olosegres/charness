/**
 * @description The pure rules of the json-stream unconsumed-input account: which written messages an echo carries, and which
 * may still be on their way. The adapter's wiring of them (frames in, `checkIsWorking` out) is covered in
 * `claudeJsonStreamMergedInput.test.ts`; this file holds the edge inputs of the matching itself.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getInputsAfterEcho, getInputsAfterTurnEnd, getInputsOnTheirWay, getInputsWithOldestEchoMarked, getInputsWithoutEchoMarks, type UnconsumedInput } from '../utils/jsonStreamUnconsumedInput';
import { unconsumedInputGraceMs } from '../utils/jsonStreamPendingWork';

const now = 5_000_000;
const written = (...texts: string[]): UnconsumedInput[] => texts.map((text) => ({ text, since: now, hasUnmatchedEcho: false }));
const textsOf = (inputs: readonly UnconsumedInput[]): string[] => inputs.map((input) => input.text);

describe('getInputsAfterEcho — what an echo carries is taken in', () => {
  it('one echo of one message takes that one in; the others stay', () => {
    assert.deepEqual(textsOf(getInputsAfterEcho(written('a', 'b', 'c'), 'a')), ['b', 'c']);
  });

  it('one echo of the newline-joined run takes the whole run in', () => {
    assert.deepEqual(textsOf(getInputsAfterEcho(written('a', 'b', 'c'), 'a\nb\nc')), []);
    assert.deepEqual(textsOf(getInputsAfterEcho(written('a', 'b', 'c'), 'a\nb')), ['c']);
  });

  it('a run in the MIDDLE is found: a message the CLI never echoed ahead of it does not block the ones after it', () => {
    assert.deepEqual(textsOf(getInputsAfterEcho(written('dropped', 'b', 'c'), 'b\nc')), ['dropped']);
  });

  it('equal texts are taken in oldest first, one echo at a time', () => {
    assert.deepEqual(getInputsAfterEcho(written('ok', 'ok'), 'ok').length, 1);
    assert.deepEqual(getInputsAfterEcho(written('ok', 'ok'), 'ok\nok').length, 0);
  });

  it('a message whose own text holds a newline is one message: its first line alone is no echo of it', () => {
    assert.deepEqual(textsOf(getInputsAfterEcho(written('first\nsecond', 'third'), 'first')), ['first\nsecond', 'third']);
    assert.deepEqual(textsOf(getInputsAfterEcho(written('first\nsecond', 'third'), 'first\nsecond\nthird')), []);
  });

  it('text that is no echo of anything written — another shape, null, the empty text — takes nothing in', () => {
    const inputs = written('a', 'b');
    assert.deepEqual(textsOf(getInputsAfterEcho(inputs, '[Request interrupted by user]')), ['a', 'b']);
    assert.deepEqual(textsOf(getInputsAfterEcho(inputs, null)), ['a', 'b']);
    assert.deepEqual(textsOf(getInputsAfterEcho(inputs, '')), ['a', 'b']);
    assert.deepEqual(textsOf(getInputsAfterEcho([], 'a')), []);
  });

  it('whitespace is part of the text: the echo must carry it exactly', () => {
    assert.deepEqual(textsOf(getInputsAfterEcho(written('a '), 'a')), ['a ']);
    assert.deepEqual(textsOf(getInputsAfterEcho(written('a '), 'a ')), []);
  });

  it('the list it was given is not changed', () => {
    const inputs = written('a', 'b');
    getInputsAfterEcho(inputs, 'a');
    assert.deepEqual(textsOf(inputs), ['a', 'b']);
  });
});

describe('getInputsOnTheirWay / getInputsAfterTurnEnd — the bound', () => {
  it('with a turn running all of them are on their way, however old', () => {
    assert.equal(getInputsOnTheirWay({ inputs: written('a'), isBusy: true, now: now + 10 * unconsumedInputGraceMs }).length, 1);
  });

  it('with no turn only those within the grace of their write are', () => {
    assert.equal(getInputsOnTheirWay({ inputs: written('a'), isBusy: false, now: now + unconsumedInputGraceMs - 1 }).length, 1);
    assert.equal(getInputsOnTheirWay({ inputs: written('a'), isBusy: false, now: now + unconsumedInputGraceMs }).length, 0);
  });

  it('a turn end starts every message\'s wait over: the turn that takes it in is about to start', () => {
    const older: UnconsumedInput = { text: 'older', since: now - 10 * unconsumedInputGraceMs, hasUnmatchedEcho: false };
    const afterEnd = getInputsAfterTurnEnd([older, ...written('newer')], now);
    assert.deepEqual(afterEnd.map((input) => input.since), [now, now]);
    assert.equal(getInputsOnTheirWay({ inputs: afterEnd, isBusy: false, now: now + unconsumedInputGraceMs - 1 }).length, 2);
  });

  it('it drops the marked entries — taken in by the turn in a shape nothing matches — and only those (review)', () => {
    const marked = getInputsWithOldestEchoMarked(written('a', 'b', 'c'));
    assert.deepEqual(textsOf(getInputsAfterTurnEnd(marked, now)), ['b', 'c']);
    assert.deepEqual(textsOf(getInputsAfterTurnEnd(written('a', 'b'), now)), ['a', 'b'], 'a turn with no echo of ours marked nothing: a real message queued behind it stays');
  });
});

describe('getInputsWithOldestEchoMarked / getInputsWithoutEchoMarks — the marks are tied to entries', () => {
  it('each unmatched echo marks the oldest entry not marked yet, never more than there are', () => {
    const once = getInputsWithOldestEchoMarked(written('a', 'b', 'c'));
    assert.deepEqual(once.map((input) => input.hasUnmatchedEcho), [true, false, false]);
    const twice = getInputsWithOldestEchoMarked(once);
    assert.deepEqual(twice.map((input) => input.hasUnmatchedEcho), [true, true, false]);
    assert.deepEqual(getInputsWithOldestEchoMarked(getInputsWithOldestEchoMarked(twice)).map((input) => input.hasUnmatchedEcho), [true, true, true]);
    assert.deepEqual(getInputsWithOldestEchoMarked([]), [], 'nothing listed: nothing marked, nothing written later is touched');
  });

  it('a message written after the echo is not marked by it, and one taken off by a later echo takes its mark with it', () => {
    const marked = getInputsWithOldestEchoMarked(written('a'));
    const withLater = [...marked, ...written('later')];
    assert.deepEqual(withLater.map((input) => input.hasUnmatchedEcho), [true, false]);
    assert.deepEqual(textsOf(getInputsAfterTurnEnd(getInputsAfterEcho(withLater, 'a'), now)), ['later'], 'the marked one was matched after all: it is gone, the later one stays');
  });

  it('a new turn\'s start (or an interrupt) forgets the marks, so a turn that never reported a result leaves none behind', () => {
    const marked = getInputsWithOldestEchoMarked(written('a', 'b'));
    const forgotten = getInputsWithoutEchoMarks(marked);
    assert.deepEqual(forgotten.map((input) => input.hasUnmatchedEcho), [false, false]);
    assert.deepEqual(textsOf(getInputsAfterTurnEnd(forgotten, now)), ['a', 'b']);
  });
});
