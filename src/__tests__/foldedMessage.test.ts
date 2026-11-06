/**
 * @description Coverage for `connectors/telegram/foldedMessage.ts`: the headline plus a detail folded under it in an
 * EXPANDABLE block quotation (Telegram HTML). What matters is that nothing in the detail — a prompt or a log, both
 * free text — can break the markup or smuggle a tag in, and that the whole message always fits one Telegram message.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFoldedMessageHtml } from '../connectors/telegram/foldedMessage';
import { MAX_MESSAGE_LEN, TELEGRAM_HARD_LIMIT } from '../connectors/telegram/messageSplit';

/** The text Telegram would count: the markup removed, the three entities decoded. */
function getParsedLength(html: string): number {
  return html
    .replace(/<\/?blockquote( expandable)?>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').length;
}

test('the detail goes under the headline in an expandable block quotation', () => {
  assert.equal(
    buildFoldedMessageHtml('⏰ Scheduled: Nightly build · daily at 02:00', 'Run the build\nand report'),
    '⏰ Scheduled: Nightly build · daily at 02:00\n\n<blockquote expandable>Run the build\nand report</blockquote>',
  );
});

test('markup characters in the headline and the detail are escaped — a log cannot inject a tag or close the quotation', () => {
  const html = buildFoldedMessageHtml('🔔 Check "a<b>" fired', 'x </blockquote><b>bold</b> & <a href="tg://user?id=1">link</a>');
  assert.equal(
    html,
    '🔔 Check "a&lt;b&gt;" fired\n\n<blockquote expandable>x &lt;/blockquote&gt;&lt;b&gt;bold&lt;/b&gt; &amp; &lt;a href="tg://user?id=1"&gt;link&lt;/a&gt;</blockquote>',
  );
  assert.equal(html.match(/<blockquote/g)?.length, 1, 'one quotation, the one the builder opened');
  assert.equal(html.match(/<\/blockquote>/g)?.length, 1);
});

test('control characters are dropped; surrounding blank space of the detail is trimmed', () => {
  assert.equal(
    buildFoldedMessageHtml('head\u0000er', '\n\n  \u001b[31mred\u001b[0m text \n'),
    'header\n\n<blockquote expandable>[31mred[0m text</blockquote>',
  );
});

test('a blank detail leaves just the (escaped) headline', () => {
  assert.equal(buildFoldedMessageHtml('Check <x> fired', ' \n\t '), 'Check &lt;x&gt; fired');
});

test('a detail longer than the room is cut and marked, and the parsed message stays within the limit', () => {
  const headline = '⏰ Scheduled: Nightly build · daily at 02:00';
  const detail = `${'a & b < c\n'.repeat(900)}END`;
  const html = buildFoldedMessageHtml(headline, detail);
  assert.ok(getParsedLength(html) <= MAX_MESSAGE_LEN, `${getParsedLength(html)} parsed characters`);
  assert.ok(getParsedLength(html) <= TELEGRAM_HARD_LIMIT);
  assert.ok(html.endsWith('…</blockquote>'), 'the cut is marked inside the quotation');
  assert.ok(!html.includes('END'), 'the beginning of a prompt is what is kept');
  assert.ok(html.length > MAX_MESSAGE_LEN, 'the escaped form is longer than the parsed one: the budget counts what Telegram counts');
});

test('a cut never splits an emoji', () => {
  const html = buildFoldedMessageHtml('h', '😀'.repeat(MAX_MESSAGE_LEN));
  assert.doesNotMatch(html, /[\ud800-\udbff](?![\udc00-\udfff])/, 'no lone high surrogate');
  assert.ok(getParsedLength(html) <= MAX_MESSAGE_LEN);
});

test('a headline that leaves no room for a detail is sent alone, never over the limit', () => {
  const html = buildFoldedMessageHtml('h'.repeat(MAX_MESSAGE_LEN - 2), 'detail');
  assert.ok(!html.includes('blockquote'));
  assert.ok(getParsedLength(html) <= MAX_MESSAGE_LEN);
});
