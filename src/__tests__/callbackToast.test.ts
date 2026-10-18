/**
 * @description The toast a button tap is answered with holds 200 characters. A text that fits is the toast, whole; a
 * longer one is cut for the toast (ellipsis, on a character boundary — never inside an emoji) and handed over to be
 * posted in full. Nothing is ever dropped, and no text is cut at some arbitrary shorter length. A toast the Bot API
 * refuses because the tap's query expired (a slow handler) never throws out of the handler: what the handler still has
 * to do runs, and the text is posted instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerCallbackQuerySafely,
  answerCallbackWithFittedText,
  answerCallbackWithWholeText,
  callbackToastMaxLength,
} from '../connectors/telegram/commands/callbackToast';

/** A tap context that records the toast and the texts posted beside it, in order. */
function createRecorder() {
  const log: string[] = [];
  return {
    log,
    ctx: { answerCbQuery: async (text?: string) => { log.push(`toast:${text ?? ''}`); return true as const; } },
    postWhole: async (text: string) => { log.push(`post:${text}`); },
  };
}

test('a text that fits is the toast, whole, and nothing is posted', async () => {
  const { ctx, postWhole, log } = createRecorder();
  const text = 'Error: ' + 'x'.repeat(100);
  await answerCallbackWithWholeText(ctx, text, postWhole);
  assert.deepEqual(log, [`toast:${text}`]);
});

test('a text of exactly the limit still fits; one more character is cut for the toast and posted whole', async () => {
  const limitText = 'y'.repeat(callbackToastMaxLength);
  const exact = createRecorder();
  await answerCallbackWithWholeText(exact.ctx, limitText, exact.postWhole);
  assert.deepEqual(exact.log, [`toast:${limitText}`]);

  const longer = createRecorder();
  const tooLong = `${limitText}z`;
  await answerCallbackWithWholeText(longer.ctx, tooLong, longer.postWhole);
  assert.equal(longer.log.length, 2);
  const [toast, post] = longer.log;
  assert.equal(toast, `toast:${'y'.repeat(callbackToastMaxLength - 1)}…`, 'the start of the text and an ellipsis, within the limit');
  assert.equal(post, `post:${tooLong}`, 'the whole text, as a message');
});

test('the cut never splits a character: not an emoji, and not a COMBINED one (a family, a flag, a skin tone)', async () => {
  const family = '👨‍👩‍👧‍👦'; // seven code points joined, 11 UTF-16 units
  const flag = '🇩🇪'; // two regional indicators, 4 units
  const waving = '👋🏽'; // an emoji and its skin tone, 4 units
  const accented = 'e\u0301'; // a letter and a combining accent, 2 units
  for (const unit of ['😀', family, flag, waving, accented]) {
    const { ctx, postWhole, log } = createRecorder();
    const text = unit.repeat(Math.ceil(400 / unit.length));
    await answerCallbackWithWholeText(ctx, text, postWhole);
    const toast = log[0].slice('toast:'.length);
    assert.ok(toast.length <= callbackToastMaxLength, `${JSON.stringify(unit)}: ${toast.length} UTF-16 units`);
    assert.ok(toast.endsWith('…'));
    const body = toast.slice(0, -1);
    assert.ok(body.length > 0 && body === unit.repeat(body.length / unit.length), `${JSON.stringify(unit)}: only whole characters before the ellipsis`);
    assert.equal(log[1], `post:${text}`);
  }
});

test('the toast is answered before the full text is posted, so the tap is never left spinning behind a slow send', async () => {
  const { ctx, postWhole, log } = createRecorder();
  await answerCallbackWithWholeText(ctx, 'q'.repeat(300), postWhole);
  assert.ok(log[0].startsWith('toast:') && log[1].startsWith('post:'));
});

test('fitted: a text that fits is the toast, whole, and "not cut" is reported', async () => {
  const { ctx, log } = createRecorder();
  const text = 'A label the user just picked';
  assert.equal(await answerCallbackWithFittedText(ctx, text), false);
  assert.deepEqual(log, [`toast:${text}`]);
});

test('fitted: a text over the limit is answered cut, and "cut" is reported — nothing else is sent, the caller decides whether the thread already carries it', async () => {
  const { ctx, log } = createRecorder();
  const label = `${'Option with a very long label, '.repeat(12)}end`;
  assert.ok(label.length > callbackToastMaxLength);
  assert.equal(await answerCallbackWithFittedText(ctx, label), true);
  assert.equal(log.length, 1, 'the tap is answered, once');
  const toast = log[0].slice('toast:'.length);
  assert.ok(toast.length <= callbackToastMaxLength && toast.endsWith('…') && label.startsWith(toast.slice(0, -1)));
});

test('fitted: the cut never splits a combined emoji here either', async () => {
  const { ctx, log } = createRecorder();
  const family = '👨‍👩‍👧‍👦';
  await answerCallbackWithFittedText(ctx, family.repeat(40));
  const toast = log[0].slice('toast:'.length);
  assert.ok(toast.length <= callbackToastMaxLength);
  const body = toast.slice(0, -1);
  assert.equal(body, family.repeat(body.length / family.length));
});

/** What telegraf throws for an `answerCallbackQuery` sent after Telegram stopped waiting for it. */
function createStaleQueryError(): Error {
  return Object.assign(new Error('400: Bad Request: query is too old and response timeout expired or query ID is invalid'), {
    response: { error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' },
    on: { method: 'answerCallbackQuery' },
  });
}

/** A tap context whose toast is refused with `error`; records the texts posted beside it. */
function createRefusingRecorder(error: Error) {
  const log: string[] = [];
  return {
    log,
    ctx: { answerCbQuery: async (): Promise<true> => { throw error; } },
    postWhole: async (text: string) => { log.push(`post:${text}`); },
  };
}

test('a toast that arrives after the query expired does not throw, and the text is posted as a message instead', async () => {
  const { ctx, postWhole, log } = createRefusingRecorder(createStaleQueryError());
  await answerCallbackWithWholeText(ctx, 'Default account changed.', postWhole);
  assert.deepEqual(log, ['post:Default account changed.']);
});

test('any other failure of the toast is still an error: it is not swallowed, and nothing is posted', async () => {
  const failure = new Error('socket hang up');
  const { ctx, postWhole, log } = createRefusingRecorder(failure);
  await assert.rejects(answerCallbackWithWholeText(ctx, 'Default account changed.', postWhole), failure);
  assert.deepEqual(log, []);
  const tooLong = createRefusingRecorder(Object.assign(new Error('400: Bad Request: the notification text is too long'), { response: { error_code: 400, description: 'Bad Request: the notification text is too long' }, on: { method: 'answerCallbackQuery' } }));
  await assert.rejects(answerCallbackWithWholeText(tooLong.ctx, 'x', tooLong.postWhole), /too long/);
});

test('safely: reports whether the toast reached the user, swallows only the expired query, passes the text on', async () => {
  const { ctx, log } = createRecorder();
  assert.equal(await answerCallbackQuerySafely(ctx, 'Done.'), true);
  assert.equal(await answerCallbackQuerySafely(ctx), true);
  assert.deepEqual(log, ['toast:Done.', 'toast:']);
  assert.equal(await answerCallbackQuerySafely(createRefusingRecorder(createStaleQueryError()).ctx, 'Done.'), false);
  const failure = new Error('socket hang up');
  await assert.rejects(answerCallbackQuerySafely(createRefusingRecorder(failure).ctx), failure);
});

test('fitted: an expired query does not throw either, and the cut flag is still reported', async () => {
  const { ctx } = createRefusingRecorder(createStaleQueryError());
  assert.equal(await answerCallbackWithFittedText(ctx, 'short'), false);
  assert.equal(await answerCallbackWithFittedText(ctx, 'z'.repeat(callbackToastMaxLength + 1)), true);
});
