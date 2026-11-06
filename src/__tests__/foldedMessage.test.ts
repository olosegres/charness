/**
 * @description Coverage for `connectors/telegram/foldedMessage.ts`: the headline plus a detail folded under it in an
 * EXPANDABLE block quotation (Telegram HTML), and the same words as plain text for a send Telegram's HTML parser refused.
 * What matters is that nothing in the detail — a prompt or a log, both free text — can break the markup or smuggle a tag
 * in, that the plain version shows no markup and no entities, and that both always fit one Telegram message.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFoldedMessage } from '../connectors/telegram/foldedMessage';
import { MAX_MESSAGE_LEN, TELEGRAM_HARD_LIMIT } from '../connectors/telegram/messageSplit';

/** The text Telegram would count: the markup removed, the three entities decoded. */
function getParsedLength(html: string): number {
  return html
    .replace(/<\/?blockquote( expandable)?>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').length;
}

test('the detail goes under the headline in an expandable block quotation; the plain version is the same words', () => {
  assert.deepEqual(
    buildFoldedMessage('⏰ Scheduled: Nightly build · daily at 02:00', 'Run the build\nand report'),
    {
      html: '⏰ Scheduled: Nightly build · daily at 02:00\n\n<blockquote expandable>Run the build\nand report</blockquote>',
      plain: '⏰ Scheduled: Nightly build · daily at 02:00\n\nRun the build\nand report',
    },
  );
});

test('markup characters in the headline and the detail are escaped — a log cannot inject a tag or close the quotation', () => {
  const { html } = buildFoldedMessage('🔔 Check "a<b>" fired', 'x </blockquote><b>bold</b> & <a href="tg://user?id=1">link</a>');
  assert.equal(
    html,
    '🔔 Check "a&lt;b&gt;" fired\n\n<blockquote expandable>x &lt;/blockquote&gt;&lt;b&gt;bold&lt;/b&gt; &amp; &lt;a href="tg://user?id=1"&gt;link&lt;/a&gt;</blockquote>',
  );
  assert.equal(html.match(/<blockquote/g)?.length, 1, 'one quotation, the one the builder opened');
  assert.equal(html.match(/<\/blockquote>/g)?.length, 1);
});

test('the plain version is what a person should read when the HTML is refused: no tags of ours, no entities, the text as written', () => {
  const { plain } = buildFoldedMessage('🔔 Check "a<b>" fired', 'x </blockquote><b>bold</b> & more');
  assert.equal(plain, '🔔 Check "a<b>" fired\n\nx </blockquote><b>bold</b> & more');
  assert.doesNotMatch(plain, /&(lt|gt|amp);/, 'no entity is shown literally');
  assert.ok(!plain.includes('<blockquote expandable>'), 'the quotation tag is ours and never reaches the plain text');
});

test('control characters are dropped; surrounding blank space of the detail is trimmed', () => {
  assert.deepEqual(
    buildFoldedMessage('head\u0000er', '\n\n  \u001b[31mred\u001b[0m text \n'),
    { html: 'header\n\n<blockquote expandable>[31mred[0m text</blockquote>', plain: 'header\n\n[31mred[0m text' },
  );
});

test('a blank detail leaves just the headline, escaped in the HTML and as written in the plain text', () => {
  assert.deepEqual(buildFoldedMessage('Check <x> fired', ' \n\t '), { html: 'Check &lt;x&gt; fired', plain: 'Check <x> fired' });
});

test('a detail longer than the room is cut and marked, and both versions stay within the limit', () => {
  const headline = '⏰ Scheduled: Nightly build · daily at 02:00';
  const detail = `${'a & b < c\n'.repeat(900)}END`;
  const { html, plain } = buildFoldedMessage(headline, detail);
  assert.ok(getParsedLength(html) <= MAX_MESSAGE_LEN, `${getParsedLength(html)} parsed characters`);
  assert.ok(getParsedLength(html) <= TELEGRAM_HARD_LIMIT);
  assert.ok(html.endsWith('…</blockquote>'), 'the cut is marked inside the quotation');
  assert.ok(!html.includes('END'), 'the beginning of a prompt is what is kept');
  assert.ok(html.length > MAX_MESSAGE_LEN, 'the escaped form is longer than the parsed one: the budget counts what Telegram counts');
  assert.ok(plain.length <= MAX_MESSAGE_LEN, `${plain.length} plain characters`);
  assert.ok(plain.endsWith('…') && !plain.includes('END'), 'the plain text is cut the same way');
  assert.equal(plain.length, getParsedLength(html), 'the same words in both');
});

test('a cut never splits an emoji', () => {
  const { html, plain } = buildFoldedMessage('h', '😀'.repeat(MAX_MESSAGE_LEN));
  assert.doesNotMatch(html, /[\ud800-\udbff](?![\udc00-\udfff])/, 'no lone high surrogate');
  assert.doesNotMatch(plain, /[\ud800-\udbff](?![\udc00-\udfff])/);
  assert.ok(getParsedLength(html) <= MAX_MESSAGE_LEN);
});

test('a headline that leaves no room for a detail is sent alone, never over the limit', () => {
  const { html, plain } = buildFoldedMessage('h'.repeat(MAX_MESSAGE_LEN - 2), 'detail');
  assert.ok(!html.includes('blockquote'));
  assert.equal(plain, 'h'.repeat(MAX_MESSAGE_LEN - 2));
  assert.ok(getParsedLength(html) <= MAX_MESSAGE_LEN);
});
