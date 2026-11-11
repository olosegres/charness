/**
 * @description The pure half of `/access`: the rows and pages of a list, the `tlk_*` button codec (round trip, the 64-byte
 * limit, junk refused), the typed forms, the decision whether a person may be added and the line when not, and the screens —
 * list, a person's menu, the add screen, the confirmation that carries the shell-access warning, and the notices.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { t } from '../i18n';
import { topicInviteTtlMs, type TopicTalkersEntry } from '../topicTalkers';
import {
  accessCallbackRe,
  buildAccessAddCallback,
  buildAccessAddScreen,
  buildAccessConfirmCallback,
  buildAccessConfirmScreen,
  buildAccessDismissCallback,
  buildAccessEntryScreen,
  buildAccessGrantedNotice,
  buildAccessInvitedNotice,
  buildAccessListScreen,
  buildAccessOpenCallback,
  buildAccessPageCallback,
  buildAccessRevokeCallback,
  buildAccessWriterCallback,
  cutAccessLabel,
  decideAccessAdd,
  formatAccessDate,
  getAccessPageCount,
  getAccessPageOfRow,
  getAccessRowLabel,
  getAccessShellWarning,
  getScopeWords,
  listAccessRows,
  parseAccessCallback,
  parseAccessCommand,
  parseAccessUsername,
  topicAccessCallbackPrefix,
  topicAccessNoopCallback,
  topicAccessPageSize,
  type AccessAddContext,
} from '../utils/topicAccessScreenPlan';

const now = 1_800_000_000_000;
const granter = { addedAt: now - 86_400_000, addedBy: '900', addedByName: 'Sam' };

function makeEntry(talkerNames: string[], inviteNames: string[] = [], revision = 5): TopicTalkersEntry {
  return {
    revision,
    talkers: talkerNames.map((name, index) => ({ userId: `${100 + index}`, name, ...(name.startsWith('@') ? {} : {}), ...granter })),
    invites: inviteNames.map((username) => ({ username, ...granter })),
  };
}

const alice = { userId: '101', username: 'alice_w', name: 'Alice Smith', addedAt: now - 86_400_000, addedBy: '900', addedByName: 'Sam' };
const bob = { userId: '102', name: 'Bob Stone', addedAt: now - 86_400_000, addedBy: '900', addedByName: 'Sam' };

// ─── rows, pages, labels ────────────────────────────────────────────────

test('listAccessRows: the talkers first, then the waiting invitations, each with the position a button points at', () => {
  const rows = listAccessRows({ revision: 1, talkers: [alice, bob], invites: [{ username: 'carol_x', ...granter }] });
  assert.deepEqual(rows.map((row) => [row.kind, row.index]), [['talker', 0], ['talker', 1], ['invite', 2]]);
  assert.equal(rows[2].kind === 'invite' && rows[2].username, 'carol_x');
});

test('getAccessPageCount / getAccessPageOfRow: eight to a page, and an empty list still has its one page', () => {
  assert.equal(topicAccessPageSize, 8);
  assert.deepEqual([0, 1, 8, 9, 16, 17].map(getAccessPageCount), [1, 1, 1, 2, 2, 3]);
  assert.deepEqual([0, 7, 8, 15, 16].map(getAccessPageOfRow), [0, 0, 1, 1, 2]);
});

test('getAccessRowLabel: the @username, else the display name; a waiting invitation leads with ⏳', () => {
  const [aliceRow, bobRow, carolRow] = listAccessRows({ revision: 1, talkers: [alice, bob], invites: [{ username: 'carol_x', ...granter }] });
  assert.equal(getAccessRowLabel(aliceRow), '@alice_w');
  assert.equal(getAccessRowLabel(bobRow), 'Bob Stone');
  assert.equal(getAccessRowLabel(carolRow), '⏳ @carol_x');
});

test('cutAccessLabel: a long caption is cut to fit a phone with an ellipsis, on a grapheme boundary — a family emoji is never split', () => {
  assert.equal(cutAccessLabel('short'), 'short');
  const long = 'A'.repeat(60);
  assert.equal(cutAccessLabel(long).length, 30);
  assert.ok(cutAccessLabel(long).endsWith('…'));
  const family = ['👨', '👩', '👧', '👦'].join('\u200d');
  const cut = cutAccessLabel(`${'x'.repeat(28)}${family}${family}${family}`);
  assert.equal(cut, `${'x'.repeat(28)}${family}…`, 'cut between two families, none split in half');
  assert.equal([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(cut)].length, 30);
});

test('formatAccessDate: «11 Nov» — a day and a short month', () => {
  assert.equal(formatAccessDate(Date.UTC(2026, 10, 11, 12), { locale: 'en', timeZone: 'UTC' }), '11 Nov');
});

// ─── the buttons ────────────────────────────────────────────────────────

test('the tlk_* codec: every button round-trips through its parser, and every data is one the module registers', () => {
  const cases = [
    [buildAccessPageCallback(7, 2), { kind: 'page', revision: 7, page: 2 }],
    [buildAccessOpenCallback(7, 3), { kind: 'open', revision: 7, index: 3 }],
    [buildAccessRevokeCallback(7, 3), { kind: 'revoke', revision: 7, index: 3 }],
    [buildAccessAddCallback(7), { kind: 'add', revision: 7 }],
    [buildAccessWriterCallback(12, 1), { kind: 'writer', snapshotId: 12, index: 1 }],
    [buildAccessConfirmCallback(12), { kind: 'confirm', snapshotId: 12 }],
    [buildAccessDismissCallback(12), { kind: 'dismiss', snapshotId: 12 }],
    [topicAccessNoopCallback, { kind: 'noop' }],
  ] as const;
  for (const [data, expected] of cases) {
    assert.ok(data.startsWith(topicAccessCallbackPrefix), data);
    assert.ok(accessCallbackRe.test(data), data);
    assert.deepEqual(parseAccessCallback(data), expected, data);
  }
});

test('the tlk_* data stays under Telegram\'s 64 bytes at the largest numbers a list or an add screen can reach', () => {
  const huge = 99_999_999_999;
  for (const data of [buildAccessPageCallback(huge, huge), buildAccessOpenCallback(huge, huge), buildAccessRevokeCallback(huge, huge), buildAccessAddCallback(huge), buildAccessWriterCallback(huge, huge), buildAccessConfirmCallback(huge), buildAccessDismissCallback(huge)]) {
    assert.ok(Buffer.byteLength(data) <= 64, `${data} is ${Buffer.byteLength(data)} bytes`);
  }
});

test('parseAccessCallback: anything that is not one of ours is null — other modules\' data, near misses, negative and fractional numbers', () => {
  for (const data of ['', 'tlk_', 'tlk_p', 'tlk_p_1', 'tlk_p_1_2_3', 'tlk_z_1_2', 'tlk_p_-1_2', 'tlk_p_1.5_2', 'tlk_a', 'tlk_w_1', 'tlk_y', 'tlk_n_1', 'acl_p_1_2', 'think_on', 'bind_docs', ' tlk_p_1_2']) {
    assert.equal(parseAccessCallback(data), null, JSON.stringify(data));
  }
});

// ─── the typed forms ────────────────────────────────────────────────────

test('parseAccessCommand: bare opens the list; add / remove take at most one more word; anything else is unknown', () => {
  assert.deepEqual(parseAccessCommand([]), { kind: 'open' });
  assert.deepEqual(parseAccessCommand(['add']), { kind: 'add', usernameArgument: null });
  assert.deepEqual(parseAccessCommand(['ADD', '@alice']), { kind: 'add', usernameArgument: '@alice' });
  assert.deepEqual(parseAccessCommand(['remove', 'alice']), { kind: 'remove', usernameArgument: 'alice' });
  for (const args of [['list'], ['add', '@a', '@b'], ['remove', 'a', 'b'], ['@alice']]) assert.deepEqual(parseAccessCommand(args), { kind: 'unknown' }, args.join(' '));
});

test('parseAccessUsername: with or without the @, 5–32 letters, digits and underscores, a letter first and not an underscore last', () => {
  assert.equal(parseAccessUsername('@alice'), 'alice');
  assert.equal(parseAccessUsername('Alice_W9'), 'Alice_W9');
  assert.equal(parseAccessUsername('a'.repeat(32)), 'a'.repeat(32));
  for (const bad of ['', '@', '@abcd', 'a'.repeat(33), '1alice', '_alice', 'alice_', 'ali ce', 'ali-ce', 'алиса_x', '@@alice', 'alice!']) assert.equal(parseAccessUsername(bad), null, JSON.stringify(bad));
});

// ─── who may be added ───────────────────────────────────────────────────

function makeContext(overrides: Partial<AccessAddContext> = {}): AccessAddContext {
  return { botUserId: '7000', botUsername: 'Charness_Bot', adminIds: new Set(['900']), adminUsernames: new Set(['sam_admin']), ownEntry: makeEntry([]), generalEntry: makeEntry([]), now, ...overrides };
}
const personTarget = { kind: 'person', userId: '101', username: 'alice_w', name: 'Alice Smith', isBot: false } as const;

test('decideAccessAdd: an ordinary member is a person to grant, an unseen @username a waiting invitation', () => {
  assert.deepEqual(decideAccessAdd(personTarget, makeContext()), { kind: 'person', person: { userId: '101', username: 'alice_w', name: 'Alice Smith' } });
  assert.deepEqual(decideAccessAdd({ kind: 'person', userId: '102', name: 'Bob Stone', isBot: false }, makeContext()), { kind: 'person', person: { userId: '102', name: 'Bob Stone' } });
  assert.deepEqual(decideAccessAdd({ kind: 'username', username: 'Carol_X' }, makeContext()), { kind: 'invite', username: 'Carol_X' });
});

test('decideAccessAdd: refused with a line of its own — a bot, this bot, a chat\'s post, an admin, somebody listed here or in General', () => {
  const refusal = (decision: ReturnType<typeof decideAccessAdd>): string | undefined => (decision.kind === 'refused' ? decision.refusalKey : undefined);
  assert.equal(refusal(decideAccessAdd({ ...personTarget, isBot: true }, makeContext())), 'access.refuseBot');
  assert.equal(refusal(decideAccessAdd({ ...personTarget, userId: '7000', isBot: true }, makeContext())), 'access.refuseSelf');
  assert.equal(refusal(decideAccessAdd({ kind: 'chatIdentity' }, makeContext())), 'access.refuseChatIdentity');
  assert.equal(refusal(decideAccessAdd({ ...personTarget, userId: '900' }, makeContext())), 'access.refuseAdmin');
  assert.equal(refusal(decideAccessAdd(personTarget, makeContext({ ownEntry: { revision: 1, talkers: [alice], invites: [] } }))), 'access.refuseListed');
  assert.equal(refusal(decideAccessAdd(personTarget, makeContext({ generalEntry: { revision: 1, talkers: [alice], invites: [] } }))), 'access.refuseListedInGeneral');
  assert.equal(refusal(decideAccessAdd(personTarget, makeContext({ generalEntry: undefined, ownEntry: { revision: 1, talkers: [alice], invites: [] } }))), 'access.refuseListed', 'on General\'s own screen only its own list counts');
});

test('decideAccessAdd: the refusal names the person it is about, in the line that mentions one', () => {
  const decision = decideAccessAdd({ ...personTarget, userId: '900' }, makeContext());
  assert.deepEqual(decision, { kind: 'refused', refusalKey: 'access.refuseAdmin', person: '@alice_w (Alice Smith)' });
});

test('decideAccessAdd: an @username that is a talker already (by the name stored), or whose invitation still waits, is refused; an expired one is renewed', () => {
  const listed = decideAccessAdd({ kind: 'username', username: 'ALICE_W' }, makeContext({ ownEntry: { revision: 1, talkers: [alice], invites: [] } }));
  assert.deepEqual(listed, { kind: 'refused', refusalKey: 'access.refuseListed', person: '@ALICE_W' });
  const waiting = { revision: 1, talkers: [], invites: [{ username: 'carol_x', addedAt: now - 1000, addedBy: '900', addedByName: 'Sam' }] };
  assert.equal(decideAccessAdd({ kind: 'username', username: 'Carol_X' }, makeContext({ ownEntry: waiting })).kind, 'refused');
  const expired = { revision: 1, talkers: [], invites: [{ username: 'carol_x', addedAt: now - topicInviteTtlMs, addedBy: '900', addedByName: 'Sam' }] };
  assert.deepEqual(decideAccessAdd({ kind: 'username', username: 'carol_x' }, makeContext({ ownEntry: expired })), { kind: 'invite', username: 'carol_x' });
  assert.equal(decideAccessAdd({ kind: 'username', username: 'alice_w' }, makeContext({ generalEntry: { revision: 1, talkers: [alice], invites: [] } })).kind, 'refused');
});

test('decideAccessAdd: a typed @username that is an admin\'s (after a restart nothing was seen, so no id to compare) or the bot\'s own is refused — never a waiting invitation that could not resolve', () => {
  assert.deepEqual(decideAccessAdd({ kind: 'username', username: 'Sam_Admin' }, makeContext()), { kind: 'refused', refusalKey: 'access.refuseAdmin', person: '@Sam_Admin' });
  assert.deepEqual(decideAccessAdd({ kind: 'username', username: 'charness_bot' }, makeContext()), { kind: 'refused', refusalKey: 'access.refuseSelf' });
  assert.equal(decideAccessAdd({ kind: 'username', username: 'sam_adminx' }, makeContext()).kind, 'invite', 'a different name is still an ordinary invitation');
  assert.equal(decideAccessAdd({ kind: 'username', username: 'sam_admin' }, makeContext({ adminUsernames: new Set() })).kind, 'invite', 'no admin of that name: nothing to refuse');
  assert.equal(decideAccessAdd({ kind: 'username', username: 'charness_bot' }, makeContext({ botUsername: undefined })).kind, 'invite', 'the bot\'s name not known yet: nothing to compare');
});

test('getScopeWords: «here» for a topic, «in every topic» for General — the words every scope-aware line takes', () => {
  assert.equal(getScopeWords('topic'), 'here');
  assert.equal(getScopeWords('general'), 'in every topic');
  assert.equal(t('access.refuseListed', { person: '@dan', scope: getScopeWords('general') }), '@dan already may talk to the agent in every topic.');
  assert.equal(t('access.refuseListed', { person: '@dan', scope: getScopeWords('topic') }), '@dan already may talk to the agent here.');
});

// ─── the screens ────────────────────────────────────────────────────────

const labelsOf = (screen: { keyboard: { label: string }[][] }): string[][] => screen.keyboard.map((row) => row.map((button) => button.label));

test('the list of a topic: title, who is not listed, the read-access note, one button per person, Add — each button baked with the revision', () => {
  const entry: TopicTalkersEntry = { revision: 5, talkers: [alice, bob], invites: [{ username: 'carol_x', ...granter }] };
  const screen = buildAccessListScreen({ scope: 'topic', entry, page: 0, generalTalkerCount: 0, topicsWithTalkers: [] });
  assert.equal(screen.text, [
    'Who may talk to the agent in this topic\nGroup admins talk in every topic and are not listed.',
    'Everyone in the group can READ this topic. To take reading away, remove the person from the group.',
  ].join('\n\n'));
  assert.deepEqual(labelsOf(screen), [['@alice_w'], ['Bob Stone'], ['⏳ @carol_x'], ['＋ Add']]);
  assert.deepEqual(screen.keyboard.map((row) => row[0].callbackData), [buildAccessOpenCallback(5, 0), buildAccessOpenCallback(5, 1), buildAccessOpenCallback(5, 2), buildAccessAddCallback(5)]);
});

test('an empty list says so and offers Add; a topic\'s screen shows General\'s talkers in one read-only line', () => {
  const empty = buildAccessListScreen({ scope: 'topic', entry: makeEntry([]), page: 0, generalTalkerCount: 0, topicsWithTalkers: [] });
  assert.ok(empty.text.includes('Nobody besides the group admins may talk to the agent here.'));
  assert.deepEqual(labelsOf(empty), [['＋ Add']]);
  const withGeneral = buildAccessListScreen({ scope: 'topic', entry: makeEntry([]), page: 0, generalTalkerCount: 2, topicsWithTalkers: [] });
  assert.ok(withGeneral.text.includes("Also: everyone from General's list (2)."));
  assert.deepEqual(labelsOf(withGeneral), [['＋ Add']], 'a read-only line: no button for them');
});

test('General\'s screen: its own list (group-wide), and a summary of the topics that have talkers of their own', () => {
  const screen = buildAccessListScreen({ scope: 'general', entry: { revision: 2, talkers: [alice], invites: [] }, page: 0, generalTalkerCount: 0, topicsWithTalkers: [{ name: 'Design', talkerCount: 2 }, { name: 'Docs', talkerCount: 1 }] });
  assert.ok(screen.text.startsWith("Who may talk to the agent in every topic (General's list)"));
  assert.ok(screen.text.includes('Everyone in the group can READ every topic.'));
  assert.ok(screen.text.includes('Also in topics: «Design» 2, «Docs» 1'));
  const none = buildAccessListScreen({ scope: 'general', entry: makeEntry([]), page: 0, generalTalkerCount: 0, topicsWithTalkers: [] });
  assert.ok(none.text.includes('Nobody besides the group admins may talk to the agent in every topic.') && !none.text.includes('Also in topics'));
});

test('a list over eight people has pages: Previous only after the first, Next only before the last, the counter does nothing', () => {
  const entry = makeEntry(Array.from({ length: 19 }, (_, index) => `Person ${index}`));
  const first = buildAccessListScreen({ scope: 'topic', entry, page: 0, generalTalkerCount: 0, topicsWithTalkers: [] });
  assert.equal(first.keyboard.length, 8 + 1 + 1, 'eight people, the page row, Add');
  assert.deepEqual(labelsOf(first)[8], ['1 / 3', 'Next ›']);
  assert.equal(first.keyboard[8][1].callbackData, buildAccessPageCallback(5, 1));
  assert.equal(first.keyboard[8][0].callbackData, topicAccessNoopCallback);
  const middle = buildAccessListScreen({ scope: 'topic', entry, page: 1, generalTalkerCount: 0, topicsWithTalkers: [] });
  assert.deepEqual(labelsOf(middle)[8], ['‹ Previous', '2 / 3', 'Next ›']);
  assert.equal(labelsOf(middle)[0][0], 'Person 8');
  const last = buildAccessListScreen({ scope: 'topic', entry, page: 2, generalTalkerCount: 0, topicsWithTalkers: [] });
  assert.deepEqual(labelsOf(last)[3], ['‹ Previous', '3 / 3']);
  assert.equal(last.keyboard.length, 3 + 1 + 1, 'three people on the last page');
  const beyond = buildAccessListScreen({ scope: 'topic', entry, page: 99, generalTalkerCount: 0, topicsWithTalkers: [] });
  assert.equal(labelsOf(beyond)[0][0], 'Person 16', 'a page past the end shows the last one');
});

test('a footer note rides under the list (after a revoke: the person still reads the group)', () => {
  const screen = buildAccessListScreen({ scope: 'topic', entry: makeEntry([]), page: 0, generalTalkerCount: 0, topicsWithTalkers: [], footerNote: 'Alice still reads the group.' });
  assert.ok(screen.text.endsWith('\n\nAlice still reads the group.'));
});

test('a person\'s menu: who, since when and by whom, Revoke access and Back to the page they are on', () => {
  const entry: TopicTalkersEntry = { revision: 5, talkers: Array.from({ length: 10 }, (_, index) => ({ ...alice, userId: `${200 + index}`, username: `person_${index}x` })), invites: [] };
  const [row] = listAccessRows(entry).slice(9);
  const screen = buildAccessEntryScreen({ scope: 'topic', entry, row, options: { locale: 'en', timeZone: 'UTC' } });
  assert.equal(screen.text, '@person_9x (Alice Smith)\nMay talk to the agent here since 14 Jan, added by Sam.');
  assert.deepEqual(labelsOf(screen), [['Revoke access'], ['‹ Back']]);
  assert.equal(screen.keyboard[0][0].callbackData, buildAccessRevokeCallback(5, 9));
  assert.equal(screen.keyboard[1][0].callbackData, buildAccessPageCallback(5, 1), 'back to page 2, where this person is');
  const general = buildAccessEntryScreen({ scope: 'general', entry, row, options: { locale: 'en', timeZone: 'UTC' } });
  assert.ok(general.text.includes('May talk to the agent in every topic since'));
});

test('a waiting invitation\'s menu: whose first message it waits for, until when, Cancel invitation', () => {
  const entry: TopicTalkersEntry = { revision: 3, talkers: [], invites: [{ username: 'carol_x', addedAt: Date.UTC(2026, 10, 11), addedBy: '900', addedByName: 'Sam' }] };
  const [row] = listAccessRows(entry);
  const screen = buildAccessEntryScreen({ scope: 'topic', entry, row, options: { locale: 'en', timeZone: 'UTC' } });
  assert.equal(screen.text, "Waits for @carol_x's first message (until 18 Nov).");
  assert.deepEqual(labelsOf(screen), [['Cancel invitation'], ['‹ Back']]);
  assert.equal(screen.keyboard[0][0].callbackData, buildAccessRevokeCallback(3, 0));
});

test('the add screen: the three ways, the MANDATORY shell-access warning, a button for each recent ignored writer (two a row), Back', () => {
  const writers = [{ userId: '1', username: 'dan', name: 'Dan Brown' }, { userId: '2', name: 'Eve' }, { userId: '3', username: 'frank_f', name: 'Frank' }];
  const screen = buildAccessAddScreen({ scope: 'topic', revision: 5, snapshotId: 9, writers });
  assert.ok(screen.text.includes('Who should talk to the agent here?'));
  assert.ok(screen.text.includes('• reply to their message with /access add, or'));
  assert.ok(screen.text.includes("They will be able to make the agent run any command in this topic's folder. Add only people you trust with this machine."));
  assert.deepEqual(labelsOf(screen), [['@dan (Dan Brown)', 'Eve'], ['@frank_f (Frank)'], ['‹ Back']]);
  assert.equal(screen.keyboard[0][0].callbackData, buildAccessWriterCallback(9, 0));
  assert.equal(screen.keyboard[0][1].callbackData, buildAccessWriterCallback(9, 1));
  assert.equal(screen.keyboard[2][0].callbackData, buildAccessPageCallback(5, 0));
  assert.deepEqual(labelsOf(buildAccessAddScreen({ scope: 'topic', revision: 5, snapshotId: 9, writers: [] })), [['‹ Back']], 'no recent writers: the row is left out');
  assert.ok(buildAccessAddScreen({ scope: 'general', revision: 1, snapshotId: 1, writers: [] }).text.includes('the folder of EVERY topic'));
});

test('the confirmation of a typed add carries the same warning, names who, and offers Add and Cancel', () => {
  const person = buildAccessConfirmScreen({ scope: 'topic', snapshotId: 4, pending: { kind: 'person', person: { userId: '1', username: 'dan', name: 'Dan Brown' } } });
  assert.ok(person.text.startsWith('Add @dan (Dan Brown)?'));
  assert.ok(person.text.includes(getAccessShellWarning('topic')));
  assert.deepEqual(labelsOf(person), [['✅ Add', 'Cancel']]);
  assert.deepEqual(person.keyboard[0].map((button) => button.callbackData), [buildAccessConfirmCallback(4), buildAccessDismissCallback(4)]);
  const invite = buildAccessConfirmScreen({ scope: 'general', snapshotId: 4, pending: { kind: 'invite', username: 'carol_x' } });
  assert.ok(invite.text.startsWith('Add @carol_x as soon as they first write in this group?'));
  assert.ok(invite.text.includes(getAccessShellWarning('general')));
});

test('the notices: a grant says plainly what they can make the agent do, in the folder; General\'s says it for every topic; an invitation says until when', () => {
  assert.equal(
    buildAccessGrantedNotice({ scope: 'topic', person: { username: 'dan', name: 'Dan Brown' }, folder: 'docs' }),
    '✅ @dan (Dan Brown) may now talk to the agent in this topic. They can make it run any command in «docs».',
  );
  assert.ok(buildAccessGrantedNotice({ scope: 'topic', person: { name: 'Eve' }, folder: null }).includes('the folder this topic is bound to'));
  assert.ok(buildAccessGrantedNotice({ scope: 'general', person: { name: 'Eve' }, folder: 'docs' }).includes('in every topic'));
  assert.equal(
    buildAccessInvitedNotice({ scope: 'topic', username: 'carol_x', expiresAt: Date.UTC(2026, 10, 18), options: { locale: 'en', timeZone: 'UTC' } }),
    '⏳ @carol_x may talk to the agent here as soon as they write anything in this group (until 18 Nov).',
  );
  assert.equal(t('access.bindNote', { count: 2, subdir: 'docs' }), "• People who may talk to the agent here: 2 (this topic's list, General's and waiting invitations) — they now reach it in `docs`.");
});

test('a name with bracket or markdown characters needs no escaping: every screen is plain text', () => {
  const nasty = { userId: '5', name: '*_[x](y)`z`', addedAt: now, addedBy: '900', addedByName: 'S_am' };
  const entry: TopicTalkersEntry = { revision: 1, talkers: [nasty], invites: [] };
  const [row] = listAccessRows(entry);
  assert.ok(buildAccessEntryScreen({ scope: 'topic', entry, row }).text.startsWith('*_[x](y)`z`\n'));
  assert.equal(getAccessRowLabel(row), '*_[x](y)`z`');
});
