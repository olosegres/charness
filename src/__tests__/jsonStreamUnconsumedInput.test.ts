/**
 * @description The pure rules of the json-stream unconsumed-input account: which written messages an echo carries, and which
 * may still be on their way. The adapter's wiring of them (frames in, `checkIsWorking` out) is covered in
 * `claudeJsonStreamMergedInput.test.ts`; this file holds the edge inputs of the matching itself.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getInputsAfterEcho, getInputsAfterTurnEnd, getInputsOnTheirWay, type UnconsumedInput } from '../utils/jsonStreamUnconsumedInput';
import { unconsumedInputGraceMs } from '../utils/jsonStreamPendingWork';

const now = 5_000_000;
const written = (...texts: string[]): UnconsumedInput[] => texts.map((text) => ({ text, since: now, hasSeenTurnEnd: false }));
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

  it('the turn end that follows a write starts its wait over: the turn that takes it in is about to start', () => {
    const older: UnconsumedInput = { text: 'older', since: now - 10 * unconsumedInputGraceMs, hasSeenTurnEnd: false };
    const afterEnd = getInputsAfterTurnEnd([older, ...written('newer')], now);
    assert.deepEqual(afterEnd.map((input) => input.since), [now, now]);
    assert.deepEqual(afterEnd.map((input) => input.hasSeenTurnEnd), [true, true]);
    assert.equal(getInputsOnTheirWay({ inputs: afterEnd, isBusy: false, now: now + unconsumedInputGraceMs - 1 }).length, 2);
  });

  it('the NEXT turn end drops what already waited through one: that turn had its chance to echo it (review: a phantom held the turn-end readers for good)', () => {
    const afterFirstEnd = getInputsAfterTurnEnd(written('phantom'), now);
    const writtenBetween: UnconsumedInput = { text: 'written between the two turns', since: now + 1, hasSeenTurnEnd: false };
    const afterSecondEnd = getInputsAfterTurnEnd([...afterFirstEnd, writtenBetween], now + 2);
    assert.deepEqual(textsOf(afterSecondEnd), ['written between the two turns'], 'only the one written after the first end survives its own first end');
  });
});
