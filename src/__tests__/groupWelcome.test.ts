/**
 * @description The greeting General gets when the bot is added to the group: it has no title line: it opens with ONE sentence that
 * greets and names the bot (the name stays Latin), with no version, in any locale — and the text, in all 12 locales, is short, free of the old BotFather step and the environment-variable
 * name, and safe for Telegram's legacy Markdown. The bot's own posting of it is
 * `groupWelcomeE2e.test.ts`.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { t, runWithLocale, localeCodes, getKeyInLang } from '../i18n';
import { formatGroupWelcome } from '../connectors/telegram/groupWelcome';

/** A projects folder with Markdown-safe characters only (a code span cannot escape a backtick). */
const workRoot = '/home/user/projects';
/** The most non-blank lines the greeting may have. */
const greetingMaxLines = 8;
/** Telegram's legacy Markdown opens bold with `*` and code with a backtick: an unpaired one gets the send refused and the greeting never arrives. The greeting has no bold; the folder is the one code span. */
const boldMarkerCount = 0;
const codeMarkerCount = 2;
/** The product name, never translated. */
const productName = 'Charness';

test('the English greeting says what the bot is, the three steps and the projects folder in plain words', () => {
  const lines = formatGroupWelcome(t, { workRoot }).split('\n').filter((line) => line.trim() !== '');
  assert.deepEqual(lines, [
    "Hi! I'm Charness — I run Claude Code and OpenCode agents in this group's topics: one topic = one project folder = one agent.",
    'Ready to work in 3 steps:',
    '1️⃣ Make me a group admin with the rights Manage Topics, Delete Messages and Pin Messages',
    '2️⃣ Run /doctor to see what is still missing',
    '3️⃣ Create a topic: if its name matches a project folder I bind it, otherwise pick a folder from my list (or /bind <subdir>). Then start an agent: /claude or /opencode',
    `Project folders: \`${workRoot}\``,
  ]);
});

test('the greeting in every locale: translated, short, no version, no env-var name, no BotFather step, Markdown that parses', () => {
  const english = getKeyInLang('en', 'onboarding.welcome');
  assert.ok(english);
  for (const locale of localeCodes) {
    const template = getKeyInLang(locale, 'onboarding.welcome');
    assert.ok(template, `onboarding.welcome exists in ${locale}`);
    assert.ok(template.includes('{workRoot}'), `${locale}: the template takes the folder`);
    assert.ok(locale === 'en' || template !== english, `${locale}: translated, not a copy of the English text`);
    for (const stale of ['BotFather', 'setprivacy', 'WORK_ROOT']) assert.ok(!template.includes(stale), `${locale}: no «${stale}»`);
    for (const command of ['/doctor', '/bind', '/claude', '/opencode']) assert.ok(template.includes(command), `${locale}: names ${command}`);

    const rendered = runWithLocale(locale, () => formatGroupWelcome(t, { workRoot }));
    assert.ok(!/\{\w+\}/.test(rendered), `${locale}: every placeholder is filled in "${rendered}"`);
    const [opening] = rendered.split('\n');
    assert.ok(opening.includes(productName), `${locale}: the first line is a sentence that names the bot: "${opening}"`);
    assert.ok(!rendered.includes('👋'), `${locale}: no wave title line`);
    assert.notEqual(opening.trim(), productName, `${locale}: the first line is a greeting sentence, not a bare title`);
    assert.ok(!/\d+\.\d+/.test(rendered), `${locale}: no version-looking text (digits.digits) anywhere in the greeting`);
    assert.ok(rendered.includes(`\`${workRoot}\``), `${locale}: the projects folder`);
    const lines = rendered.split('\n').filter((line) => line.trim() !== '');
    assert.ok(lines.length <= greetingMaxLines, `${locale}: at most ${greetingMaxLines} lines, got ${lines.length}`);
    assert.equal(rendered.split('*').length - 1, boldMarkerCount, `${locale}: no bold marker`);
    assert.equal(rendered.split('`').length - 1, codeMarkerCount, `${locale}: one code pair (the folder)`);
    assert.ok(!rendered.includes('_'), `${locale}: no underscore, which legacy Markdown reads as italics`);
  }
});

test('the Russian greeting says «топик», the owner\'s word, not «тред»', () => {
  const rendered = runWithLocale('ru', () => formatGroupWelcome(t, { workRoot }));
  assert.ok(rendered.includes('топик'), 'it names the topic with the owner\'s word');
  assert.ok(!rendered.toLowerCase().includes('тред'), 'it does not call it a thread');
});
