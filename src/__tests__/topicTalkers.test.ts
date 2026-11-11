/**
 * @description The per-topic talker lists, as pure operations over the record `state.json` persists: adding and
 * revoking, the never-restarting revision, username invitations (expiry, resolution across topics), leaving the group,
 * identity refresh, a re-pair, and General's group-wide list.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import {
  addInviteToMap,
  addTalkerToMap,
  dropOtherSpacesFromMap,
  getEffectiveTalkerIds,
  getTalkerScope,
  normaliseUsername,
  pruneExpiredInvitesInMap,
  refreshIdentityInMap,
  removeInviteFromMap,
  removeTalkerFromMap,
  removeUserFromMap,
  resolveInvitesInMap,
  topicInviteTtlMs,
  type TopicTalkersMap,
} from '../topicTalkers';

const groupId = -1001111111111;
const designTopic = keyToString(makeTelegramKey(groupId, 42));
const docsTopic = keyToString(makeTelegramKey(groupId, 43));
const generalTopic = keyToString(makeTelegramKey(groupId, 1));
const admin = { userId: '900', name: 'Sam Admin' };
const alice = { userId: '101', username: 'Alice_W', name: 'Alice Smith' };
const bob = { userId: '102', name: 'Bob Stone' };
const now = 1_800_000_000_000;

test('normaliseUsername: lowercase, one leading @ dropped', () => {
  assert.equal(normaliseUsername('@Alice_W'), 'alice_w');
  assert.equal(normaliseUsername('alice_w'), 'alice_w');
});

test('addTalkerToMap: adds once per id, records who granted, bumps the revision', () => {
  const map: TopicTalkersMap = {};
  assert.equal(addTalkerToMap(map, designTopic, alice, admin, now), 'added');
  assert.equal(addTalkerToMap(map, designTopic, alice, admin, now + 1), 'already');
  assert.equal(map[designTopic].revision, 1, 'a refused duplicate changes nothing');
  assert.deepEqual(map[designTopic].talkers, [
    { userId: '101', username: 'Alice_W', name: 'Alice Smith', addedAt: now, addedBy: '900', addedByName: 'Sam Admin' },
  ]);
  assert.equal(addTalkerToMap(map, designTopic, bob, admin, now), 'added');
  assert.equal('username' in map[designTopic].talkers[1], false, 'a person without a username has no field');
  assert.equal(map[designTopic].revision, 2);
});

test('addTalkerToMap: a topic list is its own — the same person may talk in several topics', () => {
  const map: TopicTalkersMap = {};
  addTalkerToMap(map, designTopic, alice, admin, now);
  addTalkerToMap(map, docsTopic, alice, admin, now);
  assert.equal(getTalkerScope(map, designTopic, generalTopic, '101'), 'own');
  assert.equal(getTalkerScope(map, docsTopic, generalTopic, '101'), 'own');
  removeTalkerFromMap(map, designTopic, '101');
  assert.equal(getTalkerScope(map, designTopic, generalTopic, '101'), null);
  assert.equal(getTalkerScope(map, docsTopic, generalTopic, '101'), 'own');
});

test('removeTalkerFromMap: revokes one person; false for a stranger or an unknown topic', () => {
  const map: TopicTalkersMap = {};
  addTalkerToMap(map, designTopic, alice, admin, now);
  addTalkerToMap(map, designTopic, bob, admin, now);
  assert.equal(removeTalkerFromMap(map, designTopic, '999'), false);
  assert.equal(removeTalkerFromMap(map, docsTopic, '101'), false);
  assert.equal(map[designTopic].revision, 2, 'nothing changed, nothing bumped');
  assert.equal(removeTalkerFromMap(map, designTopic, '101'), true);
  assert.deepEqual(map[designTopic].talkers.map((talker) => talker.userId), ['102']);
  assert.equal(map[designTopic].revision, 3);
});

test('the revision never restarts: an emptied list keeps its entry, so an old keyboard cannot match a new list', () => {
  const map: TopicTalkersMap = {};
  addTalkerToMap(map, designTopic, alice, admin, now);
  const revisionWhenAliceWasListed = map[designTopic].revision;
  removeTalkerFromMap(map, designTopic, '101');
  addTalkerToMap(map, designTopic, bob, admin, now);
  assert.ok(map[designTopic].revision > revisionWhenAliceWasListed + 1, 'a keyboard drawn when Alice was listed no longer matches');
  assert.equal(map[designTopic].talkers.length, 1);
});

test('addInviteToMap: lowercase, once per name; refused when a person of that name is a talker already', () => {
  const map: TopicTalkersMap = {};
  assert.equal(addInviteToMap(map, designTopic, '@Carol_X', admin, now), 'added');
  assert.deepEqual(map[designTopic].invites, [{ username: 'carol_x', addedAt: now, addedBy: '900', addedByName: 'Sam Admin' }]);
  assert.equal(addInviteToMap(map, designTopic, 'carol_X', admin, now), 'already');
  addTalkerToMap(map, designTopic, alice, admin, now);
  assert.equal(addInviteToMap(map, designTopic, '@ALICE_w', admin, now), 'listed', 'matched on the lowercase username');
  assert.equal(map[designTopic].invites.length, 1);
});

test('removeInviteFromMap: cancels a waiting invitation by name', () => {
  const map: TopicTalkersMap = {};
  addInviteToMap(map, designTopic, 'carol_x', admin, now);
  assert.equal(removeInviteFromMap(map, designTopic, '@Carol_X'), true);
  assert.deepEqual(map[designTopic].invites, []);
  assert.equal(removeInviteFromMap(map, designTopic, 'carol_x'), false);
  assert.equal(removeInviteFromMap(map, docsTopic, 'carol_x'), false);
});

test('adding a person by id consumes the invitation that waited for their username', () => {
  const map: TopicTalkersMap = {};
  addInviteToMap(map, designTopic, 'alice_w', admin, now);
  addTalkerToMap(map, designTopic, alice, admin, now);
  assert.deepEqual(map[designTopic].invites, []);
});

test('resolveInvitesInMap: the first message of the waited-for person turns the invitation into an entry by id — in EVERY topic that waits', () => {
  const map: TopicTalkersMap = {};
  addInviteToMap(map, designTopic, 'alice_w', admin, now);
  addInviteToMap(map, docsTopic, 'ALICE_W', { userId: '901', name: 'Pat Admin' }, now);
  addInviteToMap(map, generalTopic, 'someone_else', admin, now);
  const { resolved, isChanged } = resolveInvitesInMap(map, alice, now + 1000);
  assert.equal(isChanged, true);
  assert.deepEqual(
    resolved.map((entry) => [entry.threadKey, entry.addedByName]),
    [[designTopic, 'Sam Admin'], [docsTopic, 'Pat Admin']],
  );
  assert.deepEqual(map[designTopic].talkers.map((talker) => [talker.userId, talker.username, talker.name, talker.addedBy, talker.addedAt]), [
    ['101', 'Alice_W', 'Alice Smith', '900', now + 1000],
  ]);
  assert.deepEqual(map[designTopic].invites, []);
  assert.equal(map[docsTopic].talkers[0].addedBy, '901', 'each topic keeps ITS admin as the granter');
  assert.deepEqual(map[generalTopic].invites.map((invite) => invite.username), ['someone_else'], 'another name stays waiting');
});

test('resolveInvitesInMap: nothing waits for the sender → no change; a sender without a username matches nothing', () => {
  const map: TopicTalkersMap = {};
  addInviteToMap(map, designTopic, 'alice_w', admin, now);
  const before = JSON.stringify(map);
  assert.deepEqual(resolveInvitesInMap(map, bob, now), { resolved: [], isChanged: false });
  assert.deepEqual(resolveInvitesInMap(map, { userId: '101', name: 'Alice Smith' }, now), { resolved: [], isChanged: false });
  assert.equal(JSON.stringify(map), before);
});

test('resolveInvitesInMap: an expired invitation is dropped, not honoured', () => {
  const map: TopicTalkersMap = {};
  addInviteToMap(map, designTopic, 'alice_w', admin, now);
  const { resolved, isChanged } = resolveInvitesInMap(map, alice, now + topicInviteTtlMs);
  assert.deepEqual(resolved, []);
  assert.equal(isChanged, true, 'the stale invitation is consumed');
  assert.deepEqual(map[designTopic].talkers, []);
  assert.deepEqual(map[designTopic].invites, []);
});

test('resolveInvitesInMap: a topic that lists the person already only drops the invitation (no second entry, no announcement)', () => {
  const map: TopicTalkersMap = {};
  addTalkerToMap(map, designTopic, { userId: '101', name: 'Alice Smith' }, admin, now);
  map[designTopic].invites.push({ username: 'alice_w', addedAt: now, addedBy: '900', addedByName: 'Sam Admin' });
  const { resolved } = resolveInvitesInMap(map, alice, now + 1);
  assert.deepEqual(resolved, []);
  assert.equal(map[designTopic].talkers.length, 1);
  assert.deepEqual(map[designTopic].invites, []);
});

test('pruneExpiredInvitesInMap: drops only the expired ones and says so; the revision moves with it', () => {
  const map: TopicTalkersMap = {};
  addInviteToMap(map, designTopic, 'old_one', admin, now);
  addInviteToMap(map, designTopic, 'fresh_one', admin, now + topicInviteTtlMs - 10);
  const revisionBefore = map[designTopic].revision;
  assert.equal(pruneExpiredInvitesInMap(map, now + topicInviteTtlMs - 1), false, 'the first is one ms short of its expiry');
  assert.equal(pruneExpiredInvitesInMap(map, now + topicInviteTtlMs), true);
  assert.deepEqual(map[designTopic].invites.map((invite) => invite.username), ['fresh_one']);
  assert.equal(map[designTopic].revision, revisionBefore + 1);
  assert.equal(pruneExpiredInvitesInMap(map, now + topicInviteTtlMs), false, 'a second pass finds nothing');
});

test('removeUserFromMap: leaving the group drops the person from EVERY topic, and only them', () => {
  const map: TopicTalkersMap = {};
  addTalkerToMap(map, designTopic, alice, admin, now);
  addTalkerToMap(map, docsTopic, alice, admin, now);
  addTalkerToMap(map, docsTopic, bob, admin, now);
  addTalkerToMap(map, generalTopic, alice, admin, now);
  assert.deepEqual(removeUserFromMap(map, '101').sort(), [designTopic, docsTopic, generalTopic].sort());
  assert.deepEqual(map[docsTopic].talkers.map((talker) => talker.userId), ['102']);
  assert.deepEqual(removeUserFromMap(map, '101'), [], 'already gone');
  assert.deepEqual(removeUserFromMap(map, '555'), []);
});

test('refreshIdentityInMap: a rename and a changed or dropped @username reach every entry, without moving the revision', () => {
  const map: TopicTalkersMap = {};
  addTalkerToMap(map, designTopic, alice, admin, now);
  addTalkerToMap(map, docsTopic, alice, admin, now);
  const revisions = [map[designTopic].revision, map[docsTopic].revision];
  assert.equal(refreshIdentityInMap(map, { userId: '101', username: 'Alice_W', name: 'Alice Smith' }), false, 'unchanged → no write');
  assert.equal(refreshIdentityInMap(map, { userId: '101', username: 'alice_new', name: 'Alice Jones' }), true);
  assert.deepEqual(
    [designTopic, docsTopic].map((topic) => [map[topic].talkers[0].username, map[topic].talkers[0].name]),
    [['alice_new', 'Alice Jones'], ['alice_new', 'Alice Jones']],
  );
  assert.equal(refreshIdentityInMap(map, { userId: '101', name: 'Alice Jones' }), true, 'the @username was dropped');
  assert.equal('username' in map[designTopic].talkers[0], false);
  assert.deepEqual([map[designTopic].revision, map[docsTopic].revision], revisions);
  assert.equal(refreshIdentityInMap(map, { userId: '777', name: 'Nobody' }), false);
});

test('dropOtherSpacesFromMap: a re-pair keeps the lists of the new group only; a key no codec reads goes too', () => {
  const otherGroupTopic = keyToString(makeTelegramKey(-1002222222222, 7));
  const map: TopicTalkersMap = {};
  addTalkerToMap(map, designTopic, alice, admin, now);
  addTalkerToMap(map, otherGroupTopic, bob, admin, now);
  addInviteToMap(map, otherGroupTopic, 'carol_x', admin, now);
  map['not-a-session-key'] = { revision: 1, talkers: [], invites: [] };
  assert.deepEqual(dropOtherSpacesFromMap(map, groupId.toString()).sort(), [otherGroupTopic, 'not-a-session-key'].sort());
  assert.deepEqual(Object.keys(map), [designTopic]);
});

test('General\'s list is group-wide: its talkers are effective in every topic, and a topic\'s own are not shared', () => {
  const map: TopicTalkersMap = {};
  addTalkerToMap(map, generalTopic, alice, admin, now);
  addTalkerToMap(map, designTopic, bob, admin, now);
  assert.deepEqual([...getEffectiveTalkerIds(map, designTopic, generalTopic)].sort(), ['101', '102']);
  assert.deepEqual([...getEffectiveTalkerIds(map, docsTopic, generalTopic)], ['101'], 'a topic without a list still gets General\'s');
  assert.deepEqual([...getEffectiveTalkerIds(map, generalTopic, generalTopic)], ['101'], 'Bob\'s grant is for the design topic only');
  assert.equal(getTalkerScope(map, docsTopic, generalTopic, '101'), 'general');
  assert.equal(getTalkerScope(map, generalTopic, generalTopic, '101'), 'own', 'in General itself it is the own list');
  assert.equal(getTalkerScope(map, docsTopic, generalTopic, '102'), null);
  assert.deepEqual([...getEffectiveTalkerIds({}, designTopic, generalTopic)], [], 'no record at all: nobody');
});

test('a person on both a topic list and General\'s reads as the topic\'s own entry; revoking it leaves General\'s in force', () => {
  const map: TopicTalkersMap = {};
  addTalkerToMap(map, generalTopic, alice, admin, now);
  addTalkerToMap(map, designTopic, alice, admin, now);
  assert.equal(getTalkerScope(map, designTopic, generalTopic, '101'), 'own');
  removeTalkerFromMap(map, designTopic, '101');
  assert.equal(getTalkerScope(map, designTopic, generalTopic, '101'), 'general');
  removeTalkerFromMap(map, generalTopic, '101');
  assert.equal(getTalkerScope(map, designTopic, generalTopic, '101'), null);
});
