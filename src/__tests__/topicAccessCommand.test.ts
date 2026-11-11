/**
 * @description `/access` (`connectors/telegram/commands/topicAccess.ts`) wired to ports (`commandModuleHarness.ts`: a real telegraf
 * instance against the fake Bot API, the real state store, recording topic sends) — the whole module without a bot process:
 *
 *   • WIRING — the command and the one `tlk_*` pattern;
 *   • the list — empty, with people, General's talkers on a topic's screen, a topic summary on General's;
 *   • the add screen — recent ignored writers as buttons, the warning above them, one tap grants (flushed) and posts the notice;
 *   • the typed forms — a reply, a mention picked from the member list, an @username the bot has seen and one it has not — each
 *     through a CONFIRMATION that carries the warning and grants only on «Add» (a cancel grants nothing);
 *   • refusals — a bot, the bot itself, a post made as a chat, an admin, somebody listed here or in General, a bad @username;
 *   • revoke and cancel-invitation — one tap, the person still reads the group; `/access remove` in its forms;
 *   • a keyboard that went stale — a list that changed, an add screen whose memory is gone, a tap from another chat;
 *   • the admin gate and the DM hint.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTopicAccess } from '../connectors/telegram/commands/topicAccess';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { keyToString } from '../sessionKey';
import { createRecentWriters, createSeenSenders } from '../topicTalkerMemory';
import { createCommandHarness, harnessGroup, harnessOperator, harnessThreadId, type CommandHarness } from './commandModuleHarness';

let harness: CommandHarness;
const recentWriters = createRecentWriters();
const seenSenders = createSeenSenders();
let adminIds = new Set<string>([harnessOperator.id.toString()]);
let isDmTopic = false;
const botUserId = 7000000001;

const dan = { userId: '201', username: 'dan_b', name: 'Dan Brown' };
const eve = { userId: '202', name: 'Eve Quiet' };
const generalTalker = { userId: '203', username: 'gus_g', name: 'Gus Guest' };
const toUser = (person: { userId: string; username?: string; name: string }, isBot = false) => ({ id: Number(person.userId), is_bot: isBot, first_name: person.name.split(' ')[0], ...(person.name.includes(' ') ? { last_name: person.name.split(' ').slice(1).join(' ') } : {}), ...(person.username ? { username: person.username } : {}) });
const folderOfTopic = 'docs-proj';
const warningText = "They will be able to make the agent run any command in this topic's folder. Add only people you trust with this machine.";

const groupGeneralKey = makeTelegramKey(harnessGroup.id, 1);
const otherChatSpace = -1009999999999;
let nextScreenMessageId = 900;

/** A reply to a message of `person` — what `/access add` reads. */
function replyTo(person: { userId: string; username?: string; name: string } | null, extra: object = {}): object {
  return { message_thread_id: harnessThreadId, reply_to_message: person ? { message_id: 70, from: toUser(person), ...extra } : { message_id: harnessThreadId, forum_topic_created: { name: 'T', icon_color: 0 } } };
}

const lastReply = () => {
  const reply = harness.replies.at(-1);
  assert.ok(reply, 'the module replied');
  return reply;
};
const lastEdit = () => {
  const edit = harness.edits.at(-1);
  assert.ok(edit, 'the module edited a message');
  return edit;
};
const lastToast = (): string | undefined => harness.fakeTelegram.callbackAnswers.at(-1);
const readList = () => harness.state.getTopicTalkers(harness.key);

/** Open `/access` and resolve the message the list landed on. */
async function openList(): Promise<{ messageId: number; text: string; data: string[][]; labels: string[][] }> {
  const before = harness.replies.length;
  await harness.runCommand('access');
  assert.equal(harness.replies.length, before + 1);
  const reply = lastReply();
  assert.ok(reply.messageId !== null);
  return { messageId: reply.messageId, text: reply.text, data: harness.getKeyboardData(reply), labels: harness.getKeyboardLabels(reply) };
}

/** Walk Add → the writer's button: resolve the add screen and the data of the button of `label`. */
async function openAddScreen(listMessageId: number, listData: string[][]): Promise<{ text: string; data: string[][]; labels: string[][] }> {
  const addData = listData.flat().find((data) => data.startsWith('tlk_a_'));
  assert.ok(addData, 'the list has an Add button');
  const editsBefore = harness.edits.length;
  await harness.tapButton(listMessageId, addData);
  assert.equal(harness.edits.length, editsBefore + 1, 'the list became the add screen in place');
  const edit = lastEdit();
  return { text: edit.text, data: harness.getKeyboardData(edit), labels: harness.getKeyboardLabels(edit) };
}

describe('topicAccess: /access over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    const topicAccess = createTopicAccess({
      ...harness.core,
      getAdminIds: async () => adminIds,
      getBotUserId: () => botUserId,
      getGroupGeneralKey: (key) => (harness.isGeneral ? key : makeTelegramKey(Number(key.space), 1)),
      checkIsDmKey: () => isDmTopic,
      recentWriters,
      seenSenders,
    });
    topicAccess.registerTopicAccessCommands();
    topicAccess.registerTopicAccessCallbacks();
    await harness.state.setBinding(harness.key, folderOfTopic, { topicName: 'Docs' });
  });

  after(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    // Every list of the harness chat is emptied (its revision stays, as in production), and the memory of one test never reaches the next.
    await harness.state.dropTopicTalkersOfOtherChats(otherChatSpace);
    for (const person of [dan, eve, generalTalker]) {
      recentWriters.forgetWriter(keyToString(harness.key), person.userId);
      recentWriters.forgetWriter(keyToString(groupGeneralKey), person.userId);
    }
    harness.replies.length = 0;
    harness.edits.length = 0;
    harness.fakeTelegram.callbackAnswers.length = 0;
    harness.isGeneral = false;
    harness.isAuthorised = true;
    isDmTopic = false;
    adminIds = new Set([harnessOperator.id.toString()]);
    nextScreenMessageId += 1;
  });

  it('registers /access and the one tlk_* pattern', () => {
    assert.deepEqual(harness.registeredCommandNames, ['access']);
    assert.equal(harness.registeredActionPatterns.length, 1);
    assert.match(harness.registeredActionPatterns[0], /tlk_/);
  });

  describe('the list', () => {
    it('an empty topic says nobody but the admins may talk here, and offers Add', async () => {
      const list = await openList();
      assert.ok(list.text.startsWith('Who may talk to the agent in this topic\nGroup admins talk in every topic and are not listed.'));
      assert.ok(list.text.includes('Nobody besides the group admins may talk to the agent here.'));
      assert.deepEqual(list.labels, [['＋ Add']]);
    });

    it('lists the people and the waiting invitations, and shows General\'s talkers on a topic\'s screen as one read-only line', async () => {
      await harness.state.addTopicTalker(harness.key, dan, { userId: '900', name: 'Sam' });
      await harness.state.addTopicInvite(harness.key, 'carol_x', { userId: '900', name: 'Sam' });
      await harness.state.addTopicTalker(groupGeneralKey, generalTalker, { userId: '900', name: 'Sam' });
      const list = await openList();
      assert.deepEqual(list.labels, [['@dan_b'], ['⏳ @carol_x'], ['＋ Add']]);
      assert.ok(list.text.includes("Also: everyone from General's list (1)."));
    });

    it('General\'s screen is its own list, group-wide, with a summary of the topics that have talkers of their own (named by their binding, else by number)', async () => {
      // In General mode the harness's topic stands for General itself; the talkers of OTHER topics are what the summary counts.
      const namedTopic = makeTelegramKey(harnessGroup.id, 222);
      const unnamedTopic = makeTelegramKey(harnessGroup.id, 333);
      await harness.state.setBinding(namedTopic, 'api-proj', { topicName: 'Design' });
      await harness.state.addTopicTalker(namedTopic, dan, { userId: '900', name: 'Sam' });
      await harness.state.addTopicTalker(namedTopic, eve, { userId: '900', name: 'Sam' });
      await harness.state.addTopicTalker(unnamedTopic, dan, { userId: '900', name: 'Sam' });
      harness.isGeneral = true;
      const list = await openList();
      assert.ok(list.text.startsWith("Who may talk to the agent in every topic (General's list)"));
      assert.ok(list.text.includes('Nobody besides the group admins may talk to the agent in every topic.'));
      assert.ok(list.text.includes('Also in topics: «Design» 2, «#333» 1'), list.text);
      assert.deepEqual(list.labels, [['＋ Add']], 'a topic\'s people are not General\'s');
    });

    it('a list of more than eight people pages: the page tap redraws the same message at that page', async () => {
      for (let index = 0; index < 11; index += 1) await harness.state.addTopicTalker(harness.key, { userId: `${300 + index}`, name: `Person ${index}` }, { userId: '900', name: 'Sam' });
      const list = await openList();
      assert.equal(list.labels.length, 8 + 1 + 1);
      const nextData = list.data[8][1];
      await harness.tapButton(list.messageId, nextData);
      assert.equal(harness.getKeyboardLabels(lastEdit())[0][0], 'Person 8');
      assert.deepEqual(harness.getKeyboardLabels(lastEdit())[3], ['‹ Previous', '2 / 2']);
    });

    it('the page counter does nothing', async () => {
      for (let index = 0; index < 9; index += 1) await harness.state.addTopicTalker(harness.key, { userId: `${300 + index}`, name: `Person ${index}` }, { userId: '900', name: 'Sam' });
      const list = await openList();
      const editsBefore = harness.edits.length;
      await harness.tapButton(list.messageId, 'tlk_n');
      assert.equal(harness.edits.length, editsBefore);
    });
  });

  describe('the add screen', () => {
    it('offers each person who wrote here and was ignored — not an admin, not a talker already — under the warning', async () => {
      recentWriters.noteIgnoredWriter(keyToString(harness.key), dan);
      recentWriters.noteIgnoredWriter(keyToString(harness.key), eve);
      recentWriters.noteIgnoredWriter(keyToString(harness.key), generalTalker);
      adminIds.add(eve.userId);
      await harness.state.addTopicTalker(groupGeneralKey, generalTalker, { userId: '900', name: 'Sam' });
      const list = await openList();
      const add = await openAddScreen(list.messageId, list.data);
      assert.ok(add.text.includes('Who should talk to the agent here?'));
      assert.ok(add.text.includes(warningText), 'the warning is above the buttons that grant');
      assert.deepEqual(add.labels, [['@dan_b (Dan Brown)'], ['‹ Back']], 'the admin and General\'s talker are not offered');
    });

    it('a tap on a person grants at once — flushed, announced with what they can do in the folder — and the list shows them', async () => {
      recentWriters.noteIgnoredWriter(keyToString(harness.key), dan);
      const list = await openList();
      const add = await openAddScreen(list.messageId, list.data);
      await harness.tapButton(list.messageId, add.data[0][0]);
      assert.deepEqual(readList().talkers.map((talker) => [talker.userId, talker.username, talker.name, talker.addedBy, talker.addedByName]), [['201', 'dan_b', 'Dan Brown', '424242', 'Operator']]);
      assert.equal(lastReply().text, '✅ @dan_b (Dan Brown) may now talk to the agent in this topic. They can make it run any command in «docs-proj».');
      assert.deepEqual(harness.getKeyboardLabels(lastEdit()), [['@dan_b'], ['＋ Add']]);
      assert.deepEqual(recentWriters.getRecentWriters(keyToString(harness.key)), [], 'no longer a stranger to offer');
    });

    it('an old add screen\'s tap (the screen was drawn again since) is out of date and grants nothing', async () => {
      recentWriters.noteIgnoredWriter(keyToString(harness.key), dan);
      const list = await openList();
      const firstAdd = await openAddScreen(list.messageId, list.data);
      const backData = firstAdd.data.flat().find((data) => data.startsWith('tlk_p_'));
      assert.ok(backData);
      await harness.tapButton(list.messageId, backData);
      const addAgain = await openAddScreen(list.messageId, harness.getKeyboardData(lastEdit()));
      assert.notEqual(addAgain.data[0][0], firstAdd.data[0][0], 'the screen has a snapshot of its own');
      await harness.tapButton(list.messageId, firstAdd.data[0][0]);
      assert.deepEqual(readList().talkers, []);
      assert.equal(lastToast(), 'The list changed: here it is again');
    });

    it('a tap on an add screen after the bot lost its memory (a restart) is out of date, not a crash', async () => {
      await harness.tapButton(880, 'tlk_w_999999_0');
      assert.deepEqual(readList().talkers, []);
      assert.equal(lastToast(), 'The list changed: here it is again');
    });

    it('a writer who became an admin since the screen was drawn is refused at the tap, with the line', async () => {
      recentWriters.noteIgnoredWriter(keyToString(harness.key), dan);
      const list = await openList();
      const add = await openAddScreen(list.messageId, list.data);
      adminIds.add(dan.userId);
      await harness.tapButton(list.messageId, add.data[0][0]);
      assert.deepEqual(readList().talkers, []);
      assert.equal(lastToast(), '@dan_b (Dan Brown) is already an admin: they can talk in every topic.');
    });
  });

  describe('the typed forms — through a confirmation that carries the warning', () => {
    /** The confirmation a typed add posted: its message id, text and the data of its two buttons. */
    function readConfirmation() {
      const reply = lastReply();
      assert.ok(reply.messageId !== null);
      const [[confirm, dismiss]] = harness.getKeyboardData(reply);
      return { messageId: reply.messageId, text: reply.text, confirm, dismiss };
    }

    it('a reply to a person\'s message: nothing is granted until «Add»; the confirmation says who and shows the warning', async () => {
      await harness.runCommand('access', 'add', 5, replyTo(dan));
      const confirmation = readConfirmation();
      assert.equal(confirmation.text, `Add @dan_b (Dan Brown)?\n\n${warningText}`);
      assert.deepEqual(harness.getKeyboardLabels(lastReply()), [['✅ Add', 'Cancel']]);
      assert.deepEqual(readList().talkers, [], 'the warning is read BEFORE the grant takes effect');
      await harness.tapButton(confirmation.messageId, confirmation.confirm);
      assert.deepEqual(readList().talkers.map((talker) => talker.userId), ['201']);
      assert.ok(harness.replies.some((reply) => reply.text.startsWith('✅ @dan_b (Dan Brown) may now talk to the agent in this topic.')));
      assert.deepEqual(harness.getKeyboardLabels(lastEdit()), [['@dan_b'], ['＋ Add']], 'the confirmation became the list');
    });

    it('«Cancel» grants nothing and turns the confirmation back into the list', async () => {
      await harness.runCommand('access', 'add', 5, replyTo(eve));
      const confirmation = readConfirmation();
      await harness.tapButton(confirmation.messageId, confirmation.dismiss);
      assert.deepEqual(readList().talkers, []);
      assert.deepEqual(harness.getKeyboardLabels(lastEdit()), [['＋ Add']]);
    });

    it('a confirmation tapped twice, or after the bot forgot it, grants once / nothing and says it is out of date', async () => {
      await harness.runCommand('access', 'add', 5, replyTo(eve));
      const confirmation = readConfirmation();
      await harness.tapButton(confirmation.messageId, confirmation.confirm);
      await harness.tapButton(confirmation.messageId, confirmation.confirm);
      assert.equal(readList().talkers.length, 1, 'one grant');
      assert.equal(lastToast(), 'This request is out of date: send /access add again');
      await harness.tapButton(881, 'tlk_y_999999');
      assert.equal(lastToast(), 'This request is out of date: send /access add again');
    });

    it('a person picked from the member list (a text mention, which carries the id) counts as a reply', async () => {
      await harness.runCommand('access', 'add Eve Quiet', 5, { message_thread_id: harnessThreadId, entities: [{ type: 'text_mention', offset: 12, length: 9, user: toUser(eve) }] });
      assert.ok(lastReply().text.startsWith('Add Eve Quiet?'));
    });

    it('an @username the bot has SEEN is added by id, with the name it saw', async () => {
      seenSenders.noteSender({ userId: '204', username: 'hal_h', name: 'Hal Hall' });
      await harness.runCommand('access', 'add @HAL_H');
      const confirmation = readConfirmation();
      assert.ok(confirmation.text.startsWith('Add @hal_h (Hal Hall)?'));
      await harness.tapButton(confirmation.messageId, confirmation.confirm);
      assert.deepEqual(readList().talkers.map((talker) => [talker.userId, talker.name]), [['204', 'Hal Hall']]);
      assert.deepEqual(readList().invites, []);
    });

    it('an @username the bot has NOT seen becomes a waiting invitation (lowercased), announced with its expiry', async () => {
      await harness.runCommand('access', 'add @Frank_F');
      const confirmation = readConfirmation();
      assert.equal(confirmation.text, `Add @Frank_F as soon as they first write in this group?\n\n${warningText}`);
      assert.deepEqual(readList().invites, [], 'nothing waits before «Add»');
      await harness.tapButton(confirmation.messageId, confirmation.confirm);
      assert.deepEqual(readList().invites.map((invite) => invite.username), ['frank_f']);
      assert.match(harness.replies.at(-1)?.text ?? '', /^⏳ @Frank_F may talk to the agent here as soon as they write anything in this group \(until \d+ \w+\)\.$/);
    });

    it('General\'s confirmation and notice say EVERY topic', async () => {
      harness.isGeneral = true;
      await harness.runCommand('access', 'add', 5, replyTo(dan));
      const confirmation = readConfirmation();
      assert.ok(confirmation.text.includes('the folder of EVERY topic'));
      await harness.tapButton(confirmation.messageId, confirmation.confirm);
      assert.deepEqual(readList().talkers.map((talker) => talker.userId), ['201'], 'General\'s own list (the harness\'s key stands for it)');
      assert.ok(harness.replies.at(-1)?.text.includes('may now talk to the agent in every topic. They can make it run any command in the folder of each topic.'));
    });
  });

  describe('refusals — one short line each, nothing to confirm', () => {
    /** Run `/access <argsText>` with `extras` and resolve the ONE line it answered with. */
    async function typed(argsText: string, extras: object = {}): Promise<string> {
      const repliesBefore = harness.replies.length;
      await harness.runCommand('access', argsText, 5, extras);
      assert.equal(harness.replies.length, repliesBefore + 1, 'exactly one line');
      assert.equal(harness.getKeyboardData(lastReply()).length, 0, 'no buttons: nothing to confirm');
      return lastReply().text;
    }
    /** A reply to a message written by `from` (any Telegram user object). */
    const replyToUser = (from: object, extra: object = {}): object => ({ message_thread_id: harnessThreadId, reply_to_message: { message_id: 70, from, ...extra } });

    it('a bot, this bot itself, and the «Telegram» service user (the automatic copy of a channel post)', async () => {
      assert.equal(await typed('add', replyToUser({ id: 300, is_bot: true, first_name: 'Some Bot' })), 'A bot cannot be added.');
      assert.equal(await typed('add', replyToUser({ id: botUserId, is_bot: true, first_name: 'Fake bot' })), 'The bot itself cannot be added.');
      assert.equal(await typed('add', replyToUser({ id: 777000, is_bot: false, first_name: 'Telegram' })), 'A bot cannot be added.');
      assert.deepEqual(readList().talkers, []);
    });

    it('a post made as the group or a channel is nobody — whoever Telegram names in `from`', async () => {
      const asChannel = replyToUser({ id: 136817688, is_bot: true, first_name: 'Channel' }, { sender_chat: { id: -1005550000009, type: 'channel', title: 'Ops Alerts' } });
      assert.equal(await typed('add', asChannel), 'A post made as the group or a channel is nobody to add: reply to a message of the person.');
      const noUser = { message_thread_id: harnessThreadId, reply_to_message: { message_id: 70, sender_chat: { id: -1005550000009, type: 'channel', title: 'Ops Alerts' } } };
      assert.equal(await typed('add', noUser), 'A post made as the group or a channel is nobody to add: reply to a message of the person.');
    });

    it('an admin: they talk in every topic already', async () => {
      adminIds.add(dan.userId);
      assert.equal(await typed('add', replyTo(dan)), '@dan_b (Dan Brown) is already an admin: they can talk in every topic.');
    });

    it('somebody listed already, here or in General\'s list; an @username already invited', async () => {
      await harness.state.addTopicTalker(harness.key, dan, { userId: '900', name: 'Sam' });
      assert.equal(await typed('add', replyTo(dan)), '@dan_b (Dan Brown) already may talk to the agent here.');
      await harness.state.addTopicTalker(groupGeneralKey, generalTalker, { userId: '900', name: 'Sam' });
      assert.equal(await typed('add', replyTo(generalTalker)), "@gus_g (Gus Guest) already talks to the agent in every topic (General's list).");
      assert.equal(await typed('add @dan_b'), '@dan_b already may talk to the agent here.');
      await harness.state.addTopicInvite(harness.key, 'carol_x', { userId: '900', name: 'Sam' });
      assert.equal(await typed('add @carol_x'), '@carol_x is already invited.');
    });

    it('a bad @username, no target at all, a word that is no action', async () => {
      assert.equal(await typed('add @abc'), 'That is not a valid @username: 5–32 letters, digits and underscores, starting with a letter.');
      assert.equal(await typed('add', { message_thread_id: harnessThreadId }), "Reply to the person's message with /access add, or send /access add @username.");
      assert.equal(await typed('add', replyTo(null)), "Reply to the person's message with /access add, or send /access add @username.");
      assert.equal(await typed('list'), 'Usage: /access · /access add · /access remove');
      assert.equal(await typed('add @a @b'), 'Usage: /access · /access add · /access remove');
    });
  });

  describe('revoke and cancel', () => {
    it('a tap on a person opens their menu; Revoke access removes them at once (flushed), toasts it and redraws the list with the read-access note', async () => {
      await harness.state.addTopicTalker(harness.key, dan, { userId: '900', name: 'Sam' });
      await harness.state.addTopicTalker(harness.key, eve, { userId: '900', name: 'Sam' });
      const list = await openList();
      await harness.tapButton(list.messageId, list.data[0][0]);
      assert.match(lastEdit().text, /^@dan_b \(Dan Brown\)\nMay talk to the agent here since \d+ \w+, added by Sam\.$/);
      assert.deepEqual(harness.getKeyboardLabels(lastEdit()), [['Revoke access'], ['‹ Back']]);
      const revokeData = harness.getKeyboardData(lastEdit())[0][0];
      await harness.tapButton(list.messageId, revokeData);
      assert.deepEqual(readList().talkers.map((talker) => talker.userId), ['202']);
      assert.equal(lastToast(), '@dan_b (Dan Brown) can no longer talk to the agent here');
      assert.ok(lastEdit().text.endsWith('@dan_b (Dan Brown) still reads the group. To take reading away, remove them from the group.'));
      assert.deepEqual(harness.getKeyboardLabels(lastEdit()), [['Eve Quiet'], ['＋ Add']]);
    });

    it('Back returns to the page the person is on', async () => {
      for (let index = 0; index < 10; index += 1) await harness.state.addTopicTalker(harness.key, { userId: `${300 + index}`, name: `Person ${index}` }, { userId: '900', name: 'Sam' });
      const list = await openList();
      await harness.tapButton(list.messageId, list.data[8][1]);
      await harness.tapButton(list.messageId, harness.getKeyboardData(lastEdit())[0][0]);
      const backData = harness.getKeyboardData(lastEdit())[1][0];
      await harness.tapButton(list.messageId, backData);
      assert.equal(harness.getKeyboardLabels(lastEdit())[0][0], 'Person 8', 'page 2 again');
    });

    it('a waiting invitation is cancelled the same way, with its own toast', async () => {
      await harness.state.addTopicInvite(harness.key, 'carol_x', { userId: '900', name: 'Sam' });
      const list = await openList();
      await harness.tapButton(list.messageId, list.data[0][0]);
      assert.match(lastEdit().text, /^Waits for @carol_x's first message \(until \d+ \w+\)\.$/);
      await harness.tapButton(list.messageId, harness.getKeyboardData(lastEdit())[0][0]);
      assert.deepEqual(readList().invites, []);
      assert.equal(lastToast(), 'The invitation for @carol_x is cancelled');
    });

    it('a keyboard whose list changed since it was drawn acts on nobody: «the list changed» and the current list', async () => {
      await harness.state.addTopicTalker(harness.key, dan, { userId: '900', name: 'Sam' });
      const list = await openList();
      const openDan = list.data[0][0];
      await harness.state.addTopicTalker(harness.key, eve, { userId: '900', name: 'Sam' });
      await harness.tapButton(list.messageId, openDan);
      assert.equal(lastToast(), 'The list changed: here it is again');
      assert.deepEqual(harness.getKeyboardLabels(lastEdit()), [['@dan_b'], ['Eve Quiet'], ['＋ Add']]);
      // A revoke from an OLD menu must not remove whoever now sits at that position.
      await harness.tapButton(list.messageId, openDan);
      const staleRevoke = openDan.replace('tlk_u_', 'tlk_r_');
      await harness.tapButton(list.messageId, staleRevoke);
      assert.equal(readList().talkers.length, 2, 'nobody was revoked by a stale keyboard');
      assert.equal(lastToast(), 'The list changed: here it is again');
    });

    it('a list whose revision came back after the list was emptied and refilled is still told apart (the revision never restarts)', async () => {
      await harness.state.addTopicTalker(harness.key, dan, { userId: '900', name: 'Sam' });
      const list = await openList();
      const openDan = list.data[0][0];
      await harness.state.removeTopicTalker(harness.key, dan.userId);
      await harness.state.addTopicTalker(harness.key, eve, { userId: '900', name: 'Sam' });
      await harness.tapButton(list.messageId, openDan.replace('tlk_u_', 'tlk_r_'));
      assert.deepEqual(readList().talkers.map((talker) => talker.userId), ['202']);
      assert.equal(lastToast(), 'The list changed: here it is again');
    });

    it('a tap from ANOTHER chat on an add screen of this one finds no snapshot (message ids repeat across chats)', async () => {
      recentWriters.noteIgnoredWriter(keyToString(harness.key), dan);
      const list = await openList();
      const add = await openAddScreen(list.messageId, list.data);
      await harness.asForeignChat(() => harness.tapButton(list.messageId, add.data[0][0]));
      assert.deepEqual(readList().talkers, []);
      assert.equal(lastToast(), 'The list changed: here it is again');
    });
  });

  describe('/access remove', () => {
    it('by @username (the stored one, any case), by a reply, by a mention, or an invitation by name', async () => {
      for (const person of [dan, eve, generalTalker]) await harness.state.addTopicTalker(harness.key, person, { userId: '900', name: 'Sam' });
      await harness.state.addTopicInvite(harness.key, 'carol_x', { userId: '900', name: 'Sam' });
      await harness.runCommand('access', 'remove @DAN_B');
      assert.equal(lastReply().text, '@dan_b (Dan Brown) can no longer talk to the agent here.');
      await harness.runCommand('access', 'remove', 5, replyTo(eve));
      assert.equal(lastReply().text, 'Eve Quiet can no longer talk to the agent here.');
      await harness.runCommand('access', 'remove Gus Guest', 5, { message_thread_id: harnessThreadId, entities: [{ type: 'text_mention', offset: 14, length: 9, user: toUser(generalTalker) }] });
      assert.equal(lastReply().text, '@gus_g (Gus Guest) can no longer talk to the agent here.');
      await harness.runCommand('access', 'remove carol_x');
      assert.equal(lastReply().text, 'The invitation for @carol_x is cancelled.');
      assert.deepEqual([readList().talkers, readList().invites], [[], []]);
    });

    it('nobody by that name, a bad @username, and no target', async () => {
      await harness.runCommand('access', 'remove @nobody_here');
      assert.equal(lastReply().text, 'Nobody with that name is on this list.');
      await harness.runCommand('access', 'remove @abc');
      assert.equal(lastReply().text, 'That is not a valid @username: 5–32 letters, digits and underscores, starting with a letter.');
      await harness.runCommand('access', 'remove');
      assert.equal(lastReply().text, "Reply to the person's message with /access remove, or send /access remove @username.");
    });
  });

  describe('who may use it', () => {
    it('a tap by somebody the admin gate refuses is answered with the admin-only toast and changes nothing', async () => {
      await harness.state.addTopicTalker(harness.key, dan, { userId: '900', name: 'Sam' });
      const list = await openList();
      harness.isAuthorised = false;
      const revokeData = list.data[0][0].replace('tlk_u_', 'tlk_r_');
      await harness.tapButton(list.messageId, revokeData);
      assert.equal(lastToast(), 'Only group admins can do this.');
      assert.equal(readList().talkers.length, 1);
    });

    it('in the owner\'s private chat the command only points at the topics', async () => {
      isDmTopic = true;
      await harness.runCommand('access');
      assert.equal(lastReply().text, 'Who may talk to the agent is set per topic: run /access inside a topic (or in General, for every topic).');
      assert.equal(harness.getKeyboardData(lastReply()).length, 0);
    });

    it('the command carries NO talker flag: a talker\'s /access is refused by the router (the set is pinned in routedCommandTrigger.test.ts)', () => {
      assert.ok(!['esc', 'escape', 'interrupt', 'status', 'whoami', 'help'].includes('access'));
    });
  });
});
