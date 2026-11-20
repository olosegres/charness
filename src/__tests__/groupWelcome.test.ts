/**
 * @description The greeting General gets when the bot is added to the group: its title carries the version that really runs
 * (never a literal), a version that could not be read is left out, and the text — in all 12 locales — is short, free of the
 * old BotFather step and the environment-variable name, and safe for Telegram's legacy Markdown. The bot's own posting of it is
 * `groupWelcomeE2e.test.ts`.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { t, runWithLocale, localeCodes, getKeyInLang } from '../i18n';
import { formatGroupWelcome, getGroupWelcomeTitle } from '../connectors/telegram/groupWelcome';
import { unknownRunningVersion } from '../selfUpdate/constants';

const packageVersion: string = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')).version;
/** A projects folder with Markdown-safe characters only (a code span cannot escape a backtick). */
const workRoot = '/home/user/projects';
/** The most non-blank lines the greeting may have. */
const greetingMaxLines = 8;
/** Telegram's legacy Markdown opens bold with `*` and code with a backtick: each must come in ONE pair, or the send is refused and the greeting never arrives. */
const boldMarkerCount = 2;
const codeMarkerCount = 2;

test('a version that is not known is left out of the title, never shown as «unknown»', () => {
  assert.equal(getGroupWelcomeTitle(undefined), 'Charness');
  assert.equal(getGroupWelcomeTitle(''), 'Charness');
  assert.equal(getGroupWelcomeTitle(unknownRunningVersion), 'Charness');
  assert.equal(formatGroupWelcome(t, { runningVersion: undefined, workRoot }).split('\n')[0], '👋 *Charness*');
});

test('the greeting opens with the product and the version it is given — it writes none of its own', () => {
  assert.equal(getGroupWelcomeTitle(packageVersion), `Charness ${packageVersion}`);
  const first = formatGroupWelcome(t, { runningVersion: packageVersion, workRoot });
  assert.equal(first.split('\n')[0], `👋 *Charness ${packageVersion}*`);
  const other = formatGroupWelcome(t, { runningVersion: '9.8.7', workRoot });
  assert.equal(other.split('\n')[0], '👋 *Charness 9.8.7*');
});

test('the English greeting says what the bot is, the three steps and the projects folder in plain words', () => {
  const lines = formatGroupWelcome(t, { runningVersion: '4.2.0', workRoot }).split('\n').filter((line) => line.trim() !== '');
  assert.deepEqual(lines, [
    '👋 *Charness 4.2.0*',
    "I run Claude Code and OpenCode agents in this group's topics: one topic = one project folder = one agent.",
    'Ready to work in 3 steps:',
    '1️⃣ Make me a group admin with the rights Manage Topics, Delete Messages and Pin Messages',
    '2️⃣ Run /doctor to see what is still missing',
    '3️⃣ Create a topic: if its name matches a project folder I bind it, otherwise pick a folder from my list (or /bind <subdir>). Then start an agent: /claude or /opencode',
    `Project folders: \`${workRoot}\``,
  ]);
});

test('the greeting in every locale: translated, short, no version or env-var name of its own, no BotFather step, Markdown that parses', () => {
  const english = getKeyInLang('en', 'onboarding.welcome');
  assert.ok(english);
  for (const locale of localeCodes) {
    const template = getKeyInLang(locale, 'onboarding.welcome');
    assert.ok(template, `onboarding.welcome exists in ${locale}`);
    assert.ok(template.includes('{title}') && template.includes('{workRoot}'), `${locale}: the template takes the title and the folder`);
    assert.ok(locale === 'en' || template !== english, `${locale}: translated, not a copy of the English text`);
    assert.ok(!/\d+\.\d+/.test(template), `${locale}: no version number written into the template`);
    for (const stale of ['BotFather', 'setprivacy', 'WORK_ROOT']) assert.ok(!template.includes(stale), `${locale}: no «${stale}»`);
    for (const command of ['/doctor', '/bind', '/claude', '/opencode']) assert.ok(template.includes(command), `${locale}: names ${command}`);

    const rendered = runWithLocale(locale, () => formatGroupWelcome(t, { runningVersion: packageVersion, workRoot }));
    assert.ok(!/\{\w+\}/.test(rendered), `${locale}: every placeholder is filled in "${rendered}"`);
    assert.equal(rendered.split('\n')[0], `👋 *Charness ${packageVersion}*`, `${locale}: the title`);
    assert.ok(rendered.includes(`\`${workRoot}\``), `${locale}: the projects folder`);
    const lines = rendered.split('\n').filter((line) => line.trim() !== '');
    assert.ok(lines.length <= greetingMaxLines, `${locale}: at most ${greetingMaxLines} lines, got ${lines.length}`);
    assert.equal(rendered.split('*').length - 1, boldMarkerCount, `${locale}: one bold pair`);
    assert.equal(rendered.split('`').length - 1, codeMarkerCount, `${locale}: one code pair`);
    assert.ok(!rendered.includes('_'), `${locale}: no underscore, which legacy Markdown reads as italics`);
  }
});

test('the Russian greeting says «топик», the owner\'s word, not «тред»', () => {
  const rendered = runWithLocale('ru', () => formatGroupWelcome(t, { runningVersion: packageVersion, workRoot }));
  assert.ok(rendered.includes('топик'), 'it names the topic with the owner\'s word');
  assert.ok(!rendered.toLowerCase().includes('тред'), 'it does not call it a thread');
});
