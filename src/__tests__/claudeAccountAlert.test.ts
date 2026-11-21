/**
 * @description The operator's alert about Claude accounts that cannot work because of their sign-in (`utils/claudeAccountAlert.ts`):
 *
 *   • told ONCE per change — an account usable before and not now; seen for the first time, only when it was refused on a turn or
 *     is the account new conversations start on (a folder adopted before its sign-in finished is not news); never again while it
 *     stays unusable, whatever its reason turns into; a restart reads what was told and says nothing new;
 *   • what broke (the account, why, the CLI's own words), what the bot did (the conversations moved to …, or they wait: no account
 *     can work) and what to do (sign it in again — how, where the text is read; an organization's switch asks the admin too);
 *   • an account told and usable again gets one line — unless only a status check ended its bare 401 / 403 refusal: no sign-in
 *     happened, so it leaves the told accounts quietly, and its repeat (held until a new login) is told once more, then never again;
 *   • the record keeps what a round wrote: a post that waited on Telegram writes back only its pin;
 *   • a SIGNED-OUT account (`signedOut`, `notSignedIn`) is also told in a private message with a sign-in button — the list rides the
 *     alert, so once per sign-out episode: told again only after it was signed in again and signed out again; an organization's switch
 *     and a bare 401 / 403 stay in General (a sign-in does not mend them); the message names the account in every locale. The send
 *     itself (the owner's private chat, Telegram's 403) is `signOutDmE2e.test.ts`;
 *   • the id of each private message is KEPT in the record while its account stays told, handed to the alert of the round that finds the
 *     account usable again (to be turned into «signed in again»), and dropped with it; when the private chat refused the message
 *     (403) General's alert carries one more line asking the operator to open it — for a signed-out account only, in every locale.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { StateStore } from '../state';
import { localeCodes, runWithLocale, type Locale } from '../i18n';
import type { ClaudeProfileUsability } from '../utils/claudeAuthRefusal';
import {
  claudeAccountAlertDetailMaxChars,
  getClaudeAccountAlertDetail,
  listClaudeAccountSignOutNames,
  planClaudeAccountAlert,
  renderClaudeAccountAlert,
  renderClaudeAccountSignOutDm,
  type ClaudeAccountAlert,
  type ClaudeAccountAlertState,
} from '../utils/claudeAccountAlert';

const states = (entries: Array<[string, ClaudeProfileUsability]>): Map<string, ClaudeProfileUsability> => new Map(entries);
const notLoggedIn = 'Not logged in · Please run /login';

function plan(
  previous: ClaudeAccountAlertState | undefined,
  current: Array<[string, ClaudeProfileUsability]>,
  options: { instead?: string | null; details?: Array<[string, string]>; defaultProfile?: string; backByStatusCheck?: string[] } = {},
) {
  return planClaudeAccountAlert({
    previous,
    current: states(current),
    details: new Map(options.details ?? []),
    defaultProfile: options.defaultProfile ?? 'default',
    instead: options.instead === undefined ? 'second' : options.instead,
    backByStatusCheck: new Set(options.backByStatusCheck ?? []),
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

  it('back only by a status check (a bare 401 / 403 that ended without a sign-in): it leaves the told accounts quietly, no «signed in again»', () => {
    const told: ClaudeAccountAlertState = { known: { default: 'usable', work: 'rejected' }, alerted: ['work'], pinnedMessageId: 77 };
    const { alert, next } = plan(told, [['default', 'usable'], ['work', 'usable']], { backByStatusCheck: ['work'] });
    assert.equal(alert, null);
    assert.deepEqual(next, { known: { default: 'usable', work: 'usable' }, alerted: [], pinnedMessageId: 77 }, 'the caller unpins: no told account is left');
  });

  it('a 403 that keeps coming on the same login: told once, quietly usable after the hourly check, told once more when held — then silence', () => {
    let record = plan(undefined, [['default', 'usable'], ['work', 'usable']]).next;
    const round = (state: ClaudeProfileUsability, backByStatusCheck: string[] = []) => {
      const result = plan(record, [['default', 'usable'], ['work', state]], { backByStatusCheck, details: [['work', 'API Error: 403']] });
      record = result.next;
      return result.alert;
    };
    assert.deepEqual(round('rejected')?.lost.map((loss) => loss.name), ['work'], 'the first refusal');
    assert.equal(round('usable', ['work']), null, 'the hourly check ends it: no «signed in again»');
    assert.deepEqual(round('rejected')?.lost.map((loss) => loss.name), ['work'], 'refused again: held until a new login, told once more');
    for (let hour = 0; hour < 24; hour += 1) assert.equal(round('rejected'), null, 'held: the next day of polls says nothing');
    assert.deepEqual(round('usable')?.back, ['work'], 'a new login: «signed in again», once');
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

describe('the private sign-out message: which accounts, once per episode, and its words', () => {
  it('only the accounts SIGNED OUT are in it — an organization\'s switch and a bare 401 / 403 stay in General', () => {
    const alert: ClaudeAccountAlert = {
      lost: [
        { name: 'personal', usability: 'signedOut', detail: notLoggedIn },
        { name: 'work', usability: 'orgDisabled', detail: null },
        { name: 'third', usability: 'rejected', detail: null },
        { name: 'fourth', usability: 'notSignedIn', detail: null },
      ],
      back: ['fifth'],
      instead: null,
    };
    assert.deepEqual(listClaudeAccountSignOutNames(alert), ['personal', 'fourth']);
    assert.deepEqual(listClaudeAccountSignOutNames({ lost: [], back: ['personal'], instead: 'second' }), [], 'a «signed in again» line asks nothing of the operator');
  });

  it('once per sign-out episode: the list is the alert\'s, so a refusal that repeats says nothing — only a new sign-out after a sign-in does', () => {
    const signedOut = plan(undefined, [['personal', 'signedOut'], ['second', 'usable']], { details: [['personal', notLoggedIn]] });
    assert.equal(signedOut.alert === null ? null : listClaudeAccountSignOutNames(signedOut.alert).join(), 'personal', 'the first refusal');
    const repeated = plan(signedOut.next, [['personal', 'signedOut'], ['second', 'usable']], { details: [['personal', notLoggedIn]] });
    assert.equal(repeated.alert, null, 'refused again on the next turn, and by the next poll: no alert, so no second private message');
    const asProbe = plan(signedOut.next, [['personal', 'notSignedIn'], ['second', 'usable']]);
    assert.equal(asProbe.alert, null, 'the status check finds the same sign-out: still the same episode');
    const back = plan(signedOut.next, [['personal', 'usable'], ['second', 'usable']]);
    assert.deepEqual(back.alert && listClaudeAccountSignOutNames(back.alert), [], 'signed in again: the one «signed in again» line, no sign-in message');
    const again = plan(back.next, [['personal', 'signedOut'], ['second', 'usable']]);
    assert.equal(again.alert === null ? null : listClaudeAccountSignOutNames(again.alert).join(), 'personal', 'a new sign-out episode is told again');
  });

  it('the message is the line naming the account plus the button of the /accounts sign-in, with the name baked into its data', () => {
    const dm = renderClaudeAccountSignOutDm('personal');
    assert.equal(dm.text, '🔑 Claude account «personal» is signed out — its sign-in expired. Tap the button to sign it in again.');
    assert.equal(dm.buttonLabel, '🔑 Sign in again');
    assert.equal(dm.callbackData, 'acct_signin_personal');
    assert.ok(Buffer.byteLength(renderClaudeAccountSignOutDm('x'.repeat(32)).callbackData) <= 64, 'the longest account name fits Telegram\'s 64 bytes');
  });

  for (const locale of localeCodes) {
    it(`${locale}: the message names its account, has a button label and leaves no placeholder`, () => {
      const dm = runWithLocale(locale as Locale, () => renderClaudeAccountSignOutDm('personal'));
      assert.ok(dm.text.includes('«personal»'), dm.text);
      assert.ok(dm.buttonLabel.startsWith('🔑 ') && dm.buttonLabel.length > 3, dm.buttonLabel);
      assert.ok(!/\{\w+\}/.test(`${dm.text}${dm.buttonLabel}`), `no placeholder left in ${dm.text}`);
    });
  }
});

describe('the id of the private sign-out message in the record', () => {
  const told = (messageIds: Record<string, number>, alerted: string[] = Object.keys(messageIds)): ClaudeAccountAlertState => ({
    known: { personal: 'notSignedIn', second: 'usable' },
    alerted,
    signOutMessageIds: messageIds,
  });

  it('kept while the account stays told, whatever it turns into', () => {
    const still = plan(told({ personal: 41 }), [['personal', 'notSignedIn'], ['second', 'usable']]);
    assert.equal(still.alert, null);
    assert.deepEqual(still.next.signOutMessageIds, { personal: 41 });
    const refusedNow = plan(told({ personal: 41 }), [['personal', 'signedOut'], ['second', 'usable']]);
    assert.deepEqual(refusedNow.next.signOutMessageIds, { personal: 41 }, 'still the same episode: the same message');
  });

  it('handed to the alert of the round that finds the account usable again, and dropped from the record', () => {
    const back = plan(told({ personal: 41 }), [['personal', 'usable'], ['second', 'usable']]);
    assert.deepEqual(back.alert, { lost: [], back: ['personal'], instead: 'second', backMessageIds: { personal: 41 } });
    assert.equal(back.next.signOutMessageIds, undefined, 'nothing to keep: the message is turned into «signed in again» once');
  });

  it('only the account that is back gives its message up; another told one keeps its own', () => {
    const previous: ClaudeAccountAlertState = { known: { personal: 'signedOut', work: 'notSignedIn', second: 'usable' }, alerted: ['personal', 'work'], signOutMessageIds: { personal: 41, work: 52 } };
    const round = plan(previous, [['personal', 'usable'], ['work', 'notSignedIn'], ['second', 'usable']]);
    assert.deepEqual(round.alert?.backMessageIds, { personal: 41 });
    assert.deepEqual(round.next.signOutMessageIds, { work: 52 });
  });

  it('an account with no private message (the chat was closed, or it was a General-only refusal) adds no id; an account gone from the profiles drops its id', () => {
    const noMessage = plan({ known: { personal: 'signedOut', second: 'usable' }, alerted: ['personal'] }, [['personal', 'usable'], ['second', 'usable']]);
    assert.deepEqual(noMessage.alert, { lost: [], back: ['personal'], instead: 'second' }, 'no backMessageIds key at all');
    const gone = plan(told({ personal: 41 }), [['second', 'usable']]);
    assert.equal(gone.next.signOutMessageIds, undefined);
    assert.equal(gone.alert, null, 'an account that was removed is not «signed in again»');
  });

  it('an account usable again only because a status check ended its refusal leaves quietly: no alert, and its message is dropped with it', () => {
    const quiet = plan(told({ personal: 41 }), [['personal', 'usable'], ['second', 'usable']], { backByStatusCheck: ['personal'] });
    assert.equal(quiet.alert, null);
    assert.equal(quiet.next.signOutMessageIds, undefined);
  });

  it('a new episode keeps a new message id: told again after a sign-in', () => {
    const back = plan(told({ personal: 41 }), [['personal', 'usable'], ['second', 'usable']]);
    const again = plan(back.next, [['personal', 'signedOut'], ['second', 'usable']]);
    assert.equal(again.alert?.lost[0]?.name, 'personal');
    assert.equal(again.next.signOutMessageIds, undefined, 'the message of the new episode is not sent yet');
  });
});

describe('renderClaudeAccountAlert: the line that asks the operator to open a private chat', () => {
  const signedOut: ClaudeAccountAlert = { lost: [{ name: 'personal', usability: 'signedOut', detail: null }], back: [], instead: 'second' };
  const nothingToSignIn: ClaudeAccountAlert = { lost: [{ name: 'work', usability: 'orgDisabled', detail: null }], back: [], instead: 'second' };
  const render = (alert: ClaudeAccountAlert, options?: { closedPrivateChatBot?: string }): string => renderClaudeAccountAlert(alert, (name) => `/accounts login ${name}`, options);

  it('one more line after where the conversations went, naming the bot — only when the private message was refused', () => {
    const base = render(signedOut);
    const asked = render(signedOut, { closedPrivateChatBot: '@example_bot' });
    assert.equal(asked, `${base}\n\nTo be told about this in a private message next time, open a private chat with @example_bot and press Start.`);
    assert.ok(!base.includes('private chat'), 'without a refusal the alert is as before');
  });

  it('only for a signed-out account: a refusal the private message was never for (the organization\'s switch) and a «signed in again» line do not ask', () => {
    assert.equal(render(nothingToSignIn, { closedPrivateChatBot: '@example_bot' }), render(nothingToSignIn));
    const back: ClaudeAccountAlert = { lost: [], back: ['personal'], instead: 'second' };
    assert.equal(render(back, { closedPrivateChatBot: '@example_bot' }), render(back));
  });

  for (const locale of localeCodes) {
    it(`${locale}: the line names the bot and leaves no placeholder`, () => {
      const text = runWithLocale(locale as Locale, () => render(signedOut, { closedPrivateChatBot: '@example_bot' }));
      assert.ok(text.includes('@example_bot'), text);
      assert.ok(text.includes('Start'), 'the button of the bot\'s start screen, as Telegram names it');
      assert.ok(!/\{\w+\}/.test(text), `no placeholder left in ${text}`);
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

describe('the record of what was told (state.json)', () => {
  let home = '';
  let originalHome: string | undefined;
  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-account-alert-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const createStore = async (): Promise<StateStore> => {
    const store = new StateStore(path.join(home, 'data'), { saveDebounceMs: 5 });
    await store.init();
    return store;
  };

  it('a pin written after a post waited keeps what a round wrote meanwhile — another account told stays told', async () => {
    const store = await createStore();
    await store.setClaudeAccountAlertState({ known: { default: 'signedOut', work: 'usable' }, alerted: ['default'] });
    // The post of «default» waits on Telegram; meanwhile a round tells «work».
    await store.setClaudeAccountAlertState({ known: { default: 'signedOut', work: 'orgDisabled' }, alerted: ['default', 'work'] });
    await store.setClaudeAccountAlertPinnedMessageId(41);
    assert.deepEqual(store.getClaudeAccountAlertState(), { known: { default: 'signedOut', work: 'orgDisabled' }, alerted: ['default', 'work'], pinnedMessageId: 41 });
    await store.setClaudeAccountAlertPinnedMessageId(null);
    assert.deepEqual(store.getClaudeAccountAlertState(), { known: { default: 'signedOut', work: 'orgDisabled' }, alerted: ['default', 'work'] });
    const reread = await createStore();
    assert.deepEqual(reread.getClaudeAccountAlertState()?.alerted, ['default', 'work'], 'on disk too');
  });

  it('one account\'s private message id is written into the record as it is now and dropped alone — never the rest, and nothing before a first round', async () => {
    const store = await createStore();
    await store.setClaudeAccountAlertSignOutMessageId('work', 7);
    assert.equal(store.getClaudeAccountAlertState(), undefined, 'no record yet: nothing is invented');
    await store.setClaudeAccountAlertState({ known: { personal: 'signedOut', work: 'signedOut' }, alerted: ['personal', 'work'], pinnedMessageId: 41 });
    await store.setClaudeAccountAlertSignOutMessageId('personal', 12);
    // A round in between told another account while the message of «work» was on its way.
    await store.setClaudeAccountAlertState({ known: { personal: 'signedOut', work: 'signedOut', third: 'orgDisabled' }, alerted: ['personal', 'work', 'third'], pinnedMessageId: 41, signOutMessageIds: { personal: 12 } });
    await store.setClaudeAccountAlertSignOutMessageId('work', 15);
    assert.deepEqual(store.getClaudeAccountAlertState()?.signOutMessageIds, { personal: 12, work: 15 });
    assert.deepEqual(store.getClaudeAccountAlertState()?.alerted, ['personal', 'work', 'third'], 'what the round wrote stays');
    await store.setClaudeAccountAlertSignOutMessageId('personal', null);
    assert.deepEqual(store.getClaudeAccountAlertState()?.signOutMessageIds, { work: 15 });
    await store.setClaudeAccountAlertSignOutMessageId('work', null);
    assert.equal(store.getClaudeAccountAlertState()?.signOutMessageIds, undefined, 'the last id takes the field with it');
    const reread = await createStore();
    assert.equal(reread.getClaudeAccountAlertState()?.pinnedMessageId, 41, 'on disk too');
  });

  it('a status check\'s end of a refusal is kept with its login; a new login clears both', async () => {
    const store = await createStore();
    await store.upsertClaudeProfileRecord('work', { createdAt: '2026-11-01T00:00:00.000Z', loggedIn: true });
    await store.setClaudeProfileAuthRefusal('work', { at: '2026-11-20T08:00:00.000Z', reason: 'rejected', login: 'aaaa' });
    await store.endClaudeProfileAuthRefusalByStatusCheck('work', '2026-11-20T09:00:00.000Z');
    assert.equal(store.getClaudeProfileInfo('work')?.authRefusal, undefined);
    assert.deepEqual(store.getClaudeProfileInfo('work')?.authRefusalEndedByStatusCheck, { at: '2026-11-20T09:00:00.000Z', login: 'aaaa' });
    await store.setClaudeProfileAuthRefusal('work', { at: '2026-11-20T10:00:00.000Z', reason: 'rejected', login: 'aaaa', isHeldUntilNewLogin: true });
    assert.ok(store.getClaudeProfileInfo('work')?.authRefusalEndedByStatusCheck, 'kept while the held refusal stands');
    await store.setClaudeProfileAuthRefusal('work', null);
    assert.equal(store.getClaudeProfileInfo('work')?.authRefusal, undefined);
    assert.equal(store.getClaudeProfileInfo('work')?.authRefusalEndedByStatusCheck, undefined);
  });
});
