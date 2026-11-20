/**
 * @description The operator's alert about Claude accounts that cannot work because of their sign-in (`utils/claudeAccountAlert.ts`):
 *
 *   • told ONCE per change — an account usable before and not now; seen for the first time, only when it was refused on a turn or
 *     is the account new conversations start on (a folder adopted before its sign-in finished is not news); never again while it
 *     stays unusable, whatever its reason turns into; a restart reads what was told and says nothing new;
 *   • what broke (the account, why, the CLI's own words), what the bot did (the conversations moved to …, or they wait: no account
 *     can work) and what to do (sign it in again — how, where the text is read; an organization's switch asks the admin too);
 *   • an account told and usable again gets one line.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { localeCodes, runWithLocale, type Locale } from '../i18n';
import type { ClaudeProfileUsability } from '../utils/claudeAuthRefusal';
import {
  claudeAccountAlertDetailMaxChars,
  getClaudeAccountAlertDetail,
  planClaudeAccountAlert,
  renderClaudeAccountAlert,
  type ClaudeAccountAlert,
  type ClaudeAccountAlertState,
} from '../utils/claudeAccountAlert';

const states = (entries: Array<[string, ClaudeProfileUsability]>): Map<string, ClaudeProfileUsability> => new Map(entries);
const notLoggedIn = 'Not logged in · Please run /login';

function plan(previous: ClaudeAccountAlertState | undefined, current: Array<[string, ClaudeProfileUsability]>, options: { instead?: string | null; details?: Array<[string, string]>; defaultProfile?: string } = {}) {
  return planClaudeAccountAlert({
    previous,
    current: states(current),
    details: new Map(options.details ?? []),
    defaultProfile: options.defaultProfile ?? 'default',
    instead: options.instead === undefined ? 'second' : options.instead,
  });
}

describe('planClaudeAccountAlert: once per change', () => {
  it('the live case after an upgrade — `default` (where new conversations start) found signed out, `second` fine: told once', () => {
    const first = plan(undefined, [['default', 'notSignedIn'], ['second', 'usable']]);
    assert.deepEqual(first.alert, { lost: [{ name: 'default', usability: 'notSignedIn', detail: null }], back: [], instead: 'second' });
    assert.deepEqual(first.next, { known: { default: 'notSignedIn', second: 'usable' }, alerted: ['default'] });
    const again = plan(first.next, [['default', 'notSignedIn'], ['second', 'usable']]);
    assert.equal(again.alert, null, 'the next poll, and a restart that reads the record, say nothing');
    const refusedNow = plan(first.next, [['default', 'signedOut'], ['second', 'usable']]);
    assert.equal(refusedNow.alert, null, 'still unusable, for another reason: nothing new for the operator');
  });

  it('an account that was usable and is refused on a turn: what broke, the CLI\'s words, where the conversations went', () => {
    const previous = plan(undefined, [['default', 'usable'], ['second', 'usable']]).next;
    const { alert, next } = plan(previous, [['default', 'orgDisabled'], ['second', 'usable']], { details: [['default', 'Your organization has disabled Claude subscription access for Claude Code']] });
    assert.deepEqual(alert, { lost: [{ name: 'default', usability: 'orgDisabled', detail: 'Your organization has disabled Claude subscription access for Claude Code' }], back: [], instead: 'second' });
    assert.deepEqual(next.alerted, ['default']);
  });

  it('nothing usable: the alert says the conversations wait', () => {
    const previous = plan(undefined, [['default', 'notSignedIn'], ['second', 'usable']]).next;
    const { alert } = plan(previous, [['default', 'notSignedIn'], ['second', 'signedOut']], { instead: null, details: [['second', notLoggedIn]] });
    assert.deepEqual(alert, { lost: [{ name: 'second', usability: 'signedOut', detail: notLoggedIn }], back: [], instead: null });
  });

  it('a folder adopted before its sign-in finished is not news; one refused on a turn the first time it is seen is', () => {
    const previous = plan(undefined, [['default', 'usable']]).next;
    assert.equal(plan(previous, [['default', 'usable'], ['fresh', 'notSignedIn']]).alert, null);
    assert.deepEqual(plan(previous, [['default', 'usable'], ['fresh', 'rejected']]).alert?.lost.map((loss) => loss.name), ['fresh']);
    assert.deepEqual(plan(undefined, [['work', 'notSignedIn']], { defaultProfile: 'work' }).alert?.lost.map((loss) => loss.name), ['work'], 'General\'s pick is where new conversations start');
  });

  it('a told account usable again: one line, and the pinned alert is kept in the record until the caller drops it', () => {
    const told: ClaudeAccountAlertState = { known: { default: 'signedOut', second: 'usable' }, alerted: ['default'], pinnedMessageId: 77 };
    const { alert, next } = plan(told, [['default', 'usable'], ['second', 'usable']]);
    assert.deepEqual(alert, { lost: [], back: ['default'], instead: 'second' });
    assert.deepEqual(next, { known: { default: 'usable', second: 'usable' }, alerted: [], pinnedMessageId: 77 });
    const silent = plan({ known: { fresh: 'notSignedIn' }, alerted: [] }, [['fresh', 'usable']]);
    assert.equal(silent.alert, null, 'an account never told about has nothing to come back from');
  });

  it('an account removed meanwhile leaves the record', () => {
    const { next, alert } = plan({ known: { default: 'usable', gone: 'signedOut' }, alerted: ['gone'] }, [['default', 'usable']]);
    assert.equal(alert, null);
    assert.deepEqual(next, { known: { default: 'usable' }, alerted: [] });
  });
});

describe('renderClaudeAccountAlert (English)', () => {
  const telegramHow = (name: string): string => `/accounts login ${name}`;

  it('what broke, the CLI\'s words, what to do, and where the conversations went', () => {
    const alert: ClaudeAccountAlert = { lost: [{ name: 'default', usability: 'signedOut', detail: notLoggedIn }], back: [], instead: 'second' };
    assert.equal(runWithLocale('en', () => renderClaudeAccountAlert(alert, telegramHow)), [
      '⚠️ Action needed: Claude account «default» is signed out: its sign-in expired or was revoked.',
      `The CLI said: ${notLoggedIn}`,
      'To fix it, sign it in again: /accounts login default',
      '',
      'Its conversations continue on «second», and new ones start there.',
    ].join('\n'));
  });

  it('an organization\'s switch asks the admin, or another login; with nothing usable the conversations wait', () => {
    const alert: ClaudeAccountAlert = { lost: [{ name: 'work', usability: 'orgDisabled', detail: null }], back: [], instead: null };
    const text = runWithLocale('en', () => renderClaudeAccountAlert(alert, (name) => `\`CLAUDE_CONFIG_DIR=/home/user/.charness/claude-profiles/${name} claude auth login\``));
    assert.match(text, /^⚠️ Action needed: Claude account «work» was refused: its organization turned off Claude subscription use in Claude Code\.\n/);
    assert.match(text, /ask the organization's admin to turn Claude subscription use in Claude Code back on, or sign the account in with another login: `CLAUDE_CONFIG_DIR=\/home\/user\/\.charness\/claude-profiles\/work claude auth login`/);
    assert.match(text, /No other Claude account can work right now: the conversations wait and go on once one is signed in again\.$/);
    assert.ok(!text.includes('The CLI said'), 'no CLI words, no line for them');
  });

  it('usable again: one line', () => {
    assert.equal(runWithLocale('en', () => renderClaudeAccountAlert({ lost: [], back: ['default'], instead: 'default' }, telegramHow)), '✅ Claude account «default» is signed in again and takes conversations.');
  });
});

describe('every locale', () => {
  for (const locale of localeCodes) {
    it(`${locale}: every part names its account and leaves no placeholder`, () => {
      const alert: ClaudeAccountAlert = {
        lost: [
          { name: 'default', usability: 'signedOut', detail: notLoggedIn },
          { name: 'work', usability: 'orgDisabled', detail: null },
          { name: 'third', usability: 'rejected', detail: null },
          { name: 'fourth', usability: 'notSignedIn', detail: null },
        ],
        back: ['fifth'],
        instead: null,
      };
      const text = runWithLocale(locale as Locale, () => renderClaudeAccountAlert(alert, (name) => `/accounts login ${name}`));
      for (const name of ['default', 'work', 'third', 'fourth', 'fifth']) assert.ok(text.includes(`«${name}»`), `${name} in ${text}`);
      for (const name of ['default', 'work', 'third', 'fourth']) assert.ok(text.includes(`/accounts login ${name}`), `how to sign ${name} in, in ${text}`);
      assert.ok(text.includes(notLoggedIn), 'the CLI\'s words as they are');
      assert.ok(!/\{\w+\}/.test(text), `no placeholder left in ${text}`);
      const moved = runWithLocale(locale as Locale, () => renderClaudeAccountAlert({ ...alert, instead: 'second' }, (name) => name));
      assert.ok(moved.includes('«second»'), moved);
    });
  }
});

describe('getClaudeAccountAlertDetail', () => {
  it('one line, cut to its limit', () => {
    assert.equal(getClaudeAccountAlertDetail('  Not logged in\n · Please run /login  '), 'Not logged in · Please run /login');
    const long = getClaudeAccountAlertDetail('x'.repeat(500));
    assert.equal(long.length, claudeAccountAlertDetailMaxChars);
    assert.ok(long.endsWith('…'));
  });
});
