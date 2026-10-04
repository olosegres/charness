/**
 * @description Unit coverage for the reply-quote context helpers (the
 * `[Replying to an earlier message …]` block the bot folds ahead of a forwarded
 * prompt when the operator uses Telegram's REPLY feature).
 *
 * Cases (plan §VERIFICATION 1):
 *   - genuine text reply → block with `> ` lines;
 *   - partial manual quote preferred over full text;
 *   - caption fallback when no text;
 *   - `fromBot` → `from: assistant`, else `from: user`;
 *   - topic-root reply (`replyMessageId === topicRootId`) → null;
 *   - forum service message → null;
 *   - no textual content → null;
 *   - over-cap text → truncated + `… [truncated]`, still line-prefixed;
 *   - DM (no `topicRootId`) genuine reply → block.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  extractReplyQuote,
  buildReplyQuoteBlock,
  replyQuoteMaxChars,
  type ReplyQuoteSource,
} from '../utils/replyQuote';

/** `'> '.length` — kept local so the cap assertion reads without importing internals. */
const replyQuoteLinePrefixLength = 2;

/** A genuine topic reply to a user text message, tweaked per test via overrides. */
function makeSource(overrides: Partial<ReplyQuoteSource> = {}): ReplyQuoteSource {
  return {
    replyText: 'X did Y',
    replyMessageId: 42,
    topicRootId: 4242,
    isServiceMessage: false,
    fromBot: false,
    ...overrides,
  };
}

test('extractReplyQuote: genuine text reply → quoted text', () => {
  const quote = extractReplyQuote(makeSource());
  assert.deepEqual(quote, { quotedText: 'X did Y', fromBot: false });
});

test('extractReplyQuote: undefined source → null', () => {
  assert.equal(extractReplyQuote(undefined), null);
});

test('extractReplyQuote: manual (highlighted) quote preferred over full reply text', () => {
  const quote = extractReplyQuote(
    makeSource({ manualQuoteText: 'the specific part', replyText: 'a much longer full message' }),
  );
  assert.deepEqual(quote, { quotedText: 'the specific part', fromBot: false });
});

test('extractReplyQuote: caption fallback when no text/manual quote', () => {
  const quote = extractReplyQuote(
    makeSource({ manualQuoteText: undefined, replyText: undefined, replyCaption: 'a photo caption' }),
  );
  assert.deepEqual(quote, { quotedText: 'a photo caption', fromBot: false });
});

test('extractReplyQuote: whitespace-only candidates are skipped, next non-empty wins', () => {
  const quote = extractReplyQuote(
    makeSource({ manualQuoteText: '   \n  ', replyText: 'real content' }),
  );
  assert.deepEqual(quote, { quotedText: 'real content', fromBot: false });
});

test('extractReplyQuote: topic-root reply (replyMessageId === topicRootId) → null', () => {
  const quote = extractReplyQuote(makeSource({ replyMessageId: 4242, topicRootId: 4242 }));
  assert.equal(quote, null);
});

test('extractReplyQuote: forum/service message → null', () => {
  const quote = extractReplyQuote(makeSource({ isServiceMessage: true }));
  assert.equal(quote, null);
});

test('extractReplyQuote: no textual content of any kind → null', () => {
  const quote = extractReplyQuote(
    makeSource({ manualQuoteText: undefined, replyText: undefined, replyCaption: undefined }),
  );
  assert.equal(quote, null);
});

test('extractReplyQuote: DM (no topicRootId) genuine reply → quote (topic-root guard skipped)', () => {
  const quote = extractReplyQuote(
    makeSource({ topicRootId: undefined, replyMessageId: 100, replyText: 'dm reply target' }),
  );
  assert.deepEqual(quote, { quotedText: 'dm reply target', fromBot: false });
});

test('extractReplyQuote: topicRootId 0 (General / non-forum) does not trip the root guard', () => {
  const quote = extractReplyQuote(
    makeSource({ topicRootId: 0, replyMessageId: 0, replyText: 'edge content' }),
  );
  assert.deepEqual(quote, { quotedText: 'edge content', fromBot: false });
});

test('buildReplyQuoteBlock: null quote → null', () => {
  assert.equal(buildReplyQuoteBlock(null), null);
});

test('buildReplyQuoteBlock: fromBot=false → from: user, each line prefixed', () => {
  const block = buildReplyQuoteBlock({ quotedText: 'line one\nline two', fromBot: false });
  assert.equal(
    block,
    ['[Replying to an earlier message · from: user]', '> line one', '> line two'].join('\n'),
  );
});

test('buildReplyQuoteBlock: fromBot=true → from: assistant', () => {
  const block = buildReplyQuoteBlock({ quotedText: 'X did Y', fromBot: true });
  assert.equal(
    block,
    ['[Replying to an earlier message · from: assistant]', '> X did Y'].join('\n'),
  );
});

test('buildReplyQuoteBlock: over-cap content → truncated with marker, still line-prefixed', () => {
  const longText = 'a'.repeat(replyQuoteMaxChars + 500);
  const block = buildReplyQuoteBlock({ quotedText: longText, fromBot: false });
  assert.ok(block !== null);
  assert.ok(block.startsWith('[Replying to an earlier message · from: user]\n> '));
  assert.ok(block.endsWith('… [truncated]'), 'truncation marker appended');
  // Content (a's) capped at the max; the block adds the header + `> ` + marker.
  const contentLine = block.split('\n')[1];
  assert.equal(contentLine.length, replyQuoteLinePrefixLength + replyQuoteMaxChars + '… [truncated]'.length);
});

test('extractReplyQuote → buildReplyQuoteBlock: end-to-end genuine reply', () => {
  const block = buildReplyQuoteBlock(extractReplyQuote(makeSource({ fromBot: true })));
  assert.equal(
    block,
    ['[Replying to an earlier message · from: assistant]', '> X did Y'].join('\n'),
  );
});
