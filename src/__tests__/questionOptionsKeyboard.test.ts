/**
 * @description The two helpers that now own how an OpenCode question's options
 * reach Telegram: `buildQuestionOptionsKeyboard` (options → inline keyboard) and
 * `buildKeyboardExtra` (keyboard → the `replyToThread` `extra`).
 *
 * They exist because the bot offers the same options twice with different
 * callback wiring — the live `qa_<qIdx>_<optIdx>` answers and the
 * idle-compaction `reask_<optIdx>` re-ask — and both sites used to open-code
 * Telegram's button width cap with unnamed magic numbers, a third copy of a rule
 * the connector already names.
 *
 * Both failure modes here are SILENT — a mis-elided label is rejected by the API
 * with an error nobody reads, and a misspelled `reply_markup` sends the message
 * with no buttons at all and reports nothing. Hence:
 *   • the caller's callback id arrives verbatim as `callback_data`;
 *   • an over-wide label is elided by the CONNECTOR, the caller passing it
 *     through untouched;
 *   • one button per row, so buttons stay aligned with the numbered body lines;
 *   • the keyboard lands under `reply_markup`, without disturbing `parse_mode`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildKeyboardExtra, buildQuestionOptionsKeyboard } from '../connectors/telegram/questionKeyboards';
import { telegramCapabilities } from '../connectors/telegram/outbound';
import type { OpenCodeQuestion } from '../types';

function makeQuestion(labels: string[]): OpenCodeQuestion {
  return {
    question: 'Which one?',
    header: 'Pick',
    options: labels.map((label) => ({ label })),
  };
}

/** Flatten the keyboard to `[text, callback_data]` pairs, asserting one per row. */
function getButtons(
  keyboard: ReturnType<typeof buildQuestionOptionsKeyboard>,
): Array<[string, string]> {
  assert.ok(keyboard, 'expected a keyboard');
  return keyboard.inline_keyboard.map((row) => {
    assert.equal(row.length, 1, 'one button per row keeps buttons aligned with the numbered body');
    const [button] = row;
    assert.ok('callback_data' in button, 'option buttons are callback buttons');
    return [button.text, button.callback_data];
  });
}

test('the caller callback id becomes the button payload, verbatim and per option', () => {
  const keyboard = buildQuestionOptionsKeyboard(
    makeQuestion(['Rebase', 'Merge']),
    (optionIndex) => `qa_3_${optionIndex}`,
  );

  assert.deepEqual(getButtons(keyboard), [
    ['Rebase', 'qa_3_0'],
    ['Merge', 'qa_3_1'],
  ]);
});

test('the option index is 0-based, counting up in option order', () => {
  // The body numbers the same options from 1, so an off-by-one here answers the
  // wrong option — the failure the shared helper exists to make impossible.
  const seen: number[] = [];
  buildQuestionOptionsKeyboard(makeQuestion(['a', 'b', 'c']), (optionIndex) => {
    seen.push(optionIndex);
    return `reask_${optionIndex}`;
  });

  assert.deepEqual(seen, [0, 1, 2]);
});

test('an over-wide label is elided by the connector, not by the caller', () => {
  // Load-bearing: the caller must pass the label through UNTOUCHED, so the cap
  // and its elision have exactly one owner. A label at the cap is untouched; a
  // longer one comes back shortened and ellipsised, and never dropped.
  const atCap = 'x'.repeat(40);
  const overCap = 'y'.repeat(41);
  const buttons = getButtons(
    buildQuestionOptionsKeyboard(makeQuestion([atCap, overCap]), (index) => `qa_0_${index}`),
  );

  assert.equal(buttons[0][0], atCap);
  assert.equal(buttons[1][0], `${'y'.repeat(37)}...`);
  assert.equal(buttons[1][0].length, 40);
});

test('a question with no options yields no keyboard at all', () => {
  assert.equal(buildQuestionOptionsKeyboard(makeQuestion([]), (index) => `qa_0_${index}`), undefined);
});

test('buildKeyboardExtra puts the keyboard under reply_markup and keeps the base', () => {
  const keyboard = buildQuestionOptionsKeyboard(makeQuestion(['Yes']), () => 'qa_0_0');

  assert.deepEqual(buildKeyboardExtra(keyboard, { parse_mode: 'Markdown' }), {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
  assert.deepEqual(buildKeyboardExtra(keyboard), { reply_markup: keyboard });
});

test('buildKeyboardExtra omits reply_markup entirely when there is no keyboard', () => {
  // Not `reply_markup: undefined` — the plain-text retry of a question send
  // passes this straight to the Bot API.
  assert.deepEqual(buildKeyboardExtra(undefined, { parse_mode: 'Markdown' }), {
    parse_mode: 'Markdown',
  });
  assert.deepEqual(Object.keys(buildKeyboardExtra(undefined)), []);
});

test('buildKeyboardExtra never mutates the base it was given', () => {
  const base = { parse_mode: 'Markdown' };
  buildKeyboardExtra(buildQuestionOptionsKeyboard(makeQuestion(['Yes']), () => 'qa_0_0'), base);
  assert.deepEqual(base, { parse_mode: 'Markdown' });
});

test('Telegram really does declare tappable options, so the live path builds buttons', () => {
  // The `capabilities.tappableOptions` branch the two callers guard with is
  // only the rich path while this stays true; the degraded side is exercised
  // through the S5 test double in `capabilityNegotiation.test.ts`.
  assert.equal(telegramCapabilities.tappableOptions, true);
});
