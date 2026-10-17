/**
 * @description The toast a button tap is answered with holds 200 characters. A text that fits is the toast, whole; a
 * longer one is cut for the toast (ellipsis, on a character boundary — never inside an emoji) and handed over to be
 * posted in full. Nothing is ever dropped, and no text is cut at some arbitrary shorter length.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerCallbackWithWholeText, callbackToastMaxLength } from '../connectors/telegram/commands/callbackToast';

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

test('the cut never splits an emoji (a lone surrogate would make Telegram refuse the toast)', async () => {
  const { ctx, postWhole, log } = createRecorder();
  const text = '⛔'.repeat(150) + '😀'.repeat(150); // 😀 is two UTF-16 units: a cut at 199 units lands inside one
  await answerCallbackWithWholeText(ctx, text, postWhole);
  const toast = log[0].slice('toast:'.length);
  assert.ok(toast.length <= callbackToastMaxLength, `${toast.length} UTF-16 units`);
  assert.ok(toast.endsWith('…'));
  assert.doesNotMatch(toast, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, 'no lone surrogate');
  assert.equal(log[1], `post:${text}`);
});

test('the toast is answered before the full text is posted, so the tap is never left spinning behind a slow send', async () => {
  const { ctx, postWhole, log } = createRecorder();
  await answerCallbackWithWholeText(ctx, 'q'.repeat(300), postWhole);
  assert.ok(log[0].startsWith('toast:') && log[1].startsWith('post:'));
});
