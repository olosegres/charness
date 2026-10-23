/**
 * @description `/topic` (`connectors/telegram/commands/topicCommand.ts`) wired to ports (`commandModuleHarness.ts`: a real
 * telegraf instance against the fake Bot API, the real state store, recording topic sends) with stand-ins for the folder
 * work (`createWorkFolder`, `bindNewTopic`). Pinned:
 *
 *   • the pure parts — the link that opens a topic (private group `t.me/c/…`, public group `t.me/<username>/…`), the
 *     name normalisation, every callback id under Telegram's 64-byte cap, the rights error;
 *   • the questions: a bare `/topic` asks the name and arms the capture; `/topic <name>` goes straight to the folder; a
 *     bound topic is asked «as here / other», General and an unbound topic see the picker at once; a name over 128 characters
 *     is refused and asked again; the owner's private chat is told topics need a group;
 *   • the answers: «as here», a picked folder and a created folder each make ONE topic (a second tap makes none), bind it,
 *     and turn the question's message into the answer carrying the link; a refused `createForumTopic` says what is missing;
 *   • the wizard's lifetime: the «cancel» button and `/esc` end it at ANY step (a name question, the folder question, the
 *     picker, the folder-name question) and consume its keyboard, every other command ends only a pending name question;
 *     a keyboard of another message is refused; a wizard expires; creating the topic cannot be cancelled.
 *
 * What the flow test covers instead: the text handler reaching the capture, the real group, the welcome in the new topic.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTopicCancelCallback,
  buildTopicCreateFolderCallback,
  buildTopicFolderCallback,
  buildTopicLink,
  buildTopicOtherFolderCallback,
  buildTopicPageCallback,
  buildTopicSameFolderCallback,
  checkIsMissingTopicRightsError,
  createTopicCommand,
  getPublicChatUsername,
  normaliseTopicName,
  topicNameMaxLength,
  type WorkFolderResult,
} from '../connectors/telegram/commands/topicCommand';
import { BIND_PAGE_SIZE } from '../connectors/telegram/bindPicker';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { SessionKey } from '../sessionKey';
import { t } from '../i18n';
import { createCommandHarness, harnessGroup, type CommandHarness, type RecordedSend } from './commandModuleHarness';

const folderRepoName = 'repo-one';
const otherFolders = ['alpha', 'beta', 'gamma'];
const wizardIdPattern = '[0-9a-f]{6}';

let harness: CommandHarness;
let topic: ReturnType<typeof createTopicCommand>;
let isDirectChat = false;
let workFolders: string[] = [];
let folderOutcome: WorkFolderResult = { outcome: 'ready', subdir: 'made-up' };
let bindFailure: string | null = null;
const createdFolderNames: string[] = [];
const boundTopics: Array<{ key: SessionKey; subdir: string; topicName: string }> = [];
const disarmedFolderCreationKeys: SessionKey[] = [];

/** The last thing the module sent to the topic. */
function getLastReply(): RecordedSend {
  const reply = harness.replies.at(-1);
  assert.ok(reply, 'the module sent something');
  return reply;
}

/** The wizard id baked into the callbacks of a keyboard. */
function getWizardId(sent: RecordedSend): string {
  const callback = harness.getKeyboardData(sent).flat().find((data) => data.startsWith('topic_'));
  const match = new RegExp(`^topic_[a-z]+_(${wizardIdPattern})`).exec(callback ?? '');
  assert.ok(match, `a /topic callback with a wizard id in ${harness.getKeyboardData(sent).flat().join(', ')}`);
  return match[1];
}

function getUrlButtons(sent: RecordedSend | undefined): string[] {
  const extra = sent?.extra;
  if (!extra || !('reply_markup' in extra)) return [];
  const markup = extra.reply_markup as { inline_keyboard: Array<Array<{ url?: string }>> };
  return markup.inline_keyboard.flat().flatMap((button) => (button.url === undefined ? [] : [button.url]));
}

/** Poll until `check` holds (bounded). */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** `/topic Release notes` in the bound topic: the folder question and its wizard id. */
async function askAboutFolder(): Promise<{ question: RecordedSend; wizardId: string }> {
  await harness.runCommand('topic', 'Release notes');
  const question = getLastReply();
  return { question, wizardId: getWizardId(question) };
}

describe('topicCommand: /topic over its ports', () => {
  before(async () => {
    harness = await createCommandHarness();
    topic = createTopicCommand({
      ...harness.core,
      checkIsDmKey: () => isDirectChat,
      disarmFolderCreation: (key) => {
        disarmedFolderCreationKeys.push(key);
      },
      listAvailableSubdirs: () => workFolders,
      createWorkFolder: async (_key, rawName) => {
        createdFolderNames.push(rawName);
        return folderOutcome;
      },
      bindNewTopic: async (key, subdir, topicName) => {
        boundTopics.push({ key, subdir, topicName });
        return bindFailure;
      },
    });
    topic.registerTopicCommand();
    topic.registerTopicCallbacks();
  });

  after(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    // Whatever wizard an earlier test left alive.
    while (await topic.cancelTopicWizard(harness.key)) { /* drained */ }
    harness.replies.length = 0;
    harness.edits.length = 0;
    harness.isGeneral = false;
    isDirectChat = false;
    workFolders = [...otherFolders];
    folderOutcome = { outcome: 'ready', subdir: 'made-up' };
    bindFailure = null;
    createdFolderNames.length = 0;
    boundTopics.length = 0;
    disarmedFolderCreationKeys.length = 0;
    harness.fakeTelegram.canManageTopics = true;
    harness.fakeTelegram.createdTopics.length = 0;
    harness.fakeTelegram.callbackAnswers.length = 0;
    await harness.state.setBinding(harness.key, folderRepoName);
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('registers the command and its six buttons', () => {
    assert.deepEqual(harness.registeredCommandNames, ['topic']);
    assert.equal(harness.registeredActionPatterns.length, 6);
    assert.ok(harness.registeredActionPatterns.every((pattern) => pattern.startsWith('/^topic_')));
  });

  describe('the pure parts', () => {
    it('a private group\'s topic opens at t.me/c/<id without -100>/<topic id>', () => {
      assert.equal(buildTopicLink({ chatId: -1001234567890, username: null }, 77), 'https://t.me/c/1234567890/77');
    });

    it('a public group\'s topic opens at t.me/<username>/<topic id>', () => {
      assert.equal(buildTopicLink({ chatId: -1001234567890, username: 'example_group' }, 77), 'https://t.me/example_group/77');
    });

    it('the public username comes from the chat of the update: a public supergroup has one, a private group and no chat have none', () => {
      assert.equal(getPublicChatUsername({ id: -1001234567890, type: 'supergroup', title: 'Example', username: 'example_group' }), 'example_group');
      assert.equal(getPublicChatUsername({ id: -1001234567890, type: 'supergroup', title: 'Example' }), null);
      assert.equal(getPublicChatUsername(undefined), null);
    });

    it('a chat id that is no supergroup\'s has no link', () => {
      assert.equal(buildTopicLink({ chatId: -4242, username: null }, 77), null);
    });

    it('the name loses its edge and repeated whitespace, newlines included', () => {
      assert.equal(normaliseTopicName('  my \n  new\ttopic '), 'my new topic');
    });

    it('every callback id fits the 64-byte cap, with the longest wizard id and a four-digit index', () => {
      const wizardId = 'ffffff';
      for (const data of [
        buildTopicSameFolderCallback(wizardId),
        buildTopicOtherFolderCallback(wizardId),
        buildTopicFolderCallback(wizardId, 9999),
        buildTopicPageCallback(wizardId, 9999),
        buildTopicCreateFolderCallback(wizardId),
        buildTopicCancelCallback(wizardId),
      ]) {
        assert.ok(Buffer.byteLength(data) <= 64, `${data} fits`);
      }
    });

    it('only a refusal that names the rights is the missing-rights error', () => {
      assert.equal(checkIsMissingTopicRightsError({ response: { error_code: 400, description: 'Bad Request: not enough rights to create a topic' } }), true);
      assert.equal(checkIsMissingTopicRightsError({ response: { error_code: 400, description: 'Bad Request: chat is not a forum' } }), false);
      assert.equal(checkIsMissingTopicRightsError(new Error('not enough rights')), false);
    });
  });

  describe('the questions', () => {
    it('a bare /topic asks the name, with the way out, and arms the capture', async () => {
      await harness.runCommand('topic');
      assert.equal(getLastReply().text, `${t('topic.askName')}\n${t('login.esc_hint')}`);
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), true);
    });

    it('the owner\'s private chat is told topics need a group, and nothing is armed', async () => {
      isDirectChat = true;
      await harness.runCommand('topic', 'whatever');
      assert.deepEqual(harness.replies.map((reply) => reply.text), [t('topic.dmUnsupported')]);
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), false);
    });

    it('the answer to the name question is the name: a bound topic is asked «as here» or «other», the folder\'s name on the first', async () => {
      await harness.runCommand('topic');
      await topic.submitTopicInput(harness.key, '  Release   notes ');
      const question = getLastReply();
      assert.equal(question.text, t('topic.askFolder', { name: 'Release notes' }));
      assert.deepEqual(harness.getKeyboardLabels(question), [[t('topic.sameFolderButton', { subdir: folderRepoName })], [t('topic.otherFolderButton')], [t('topic.cancelButton')]]);
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), false, 'the name was taken: the next message is the agent\'s again');
    });

    it('/topic <name> skips the name question', async () => {
      await harness.runCommand('topic', 'Release notes');
      assert.equal(harness.replies.length, 1);
      assert.equal(getLastReply().text, t('topic.askFolder', { name: 'Release notes' }));
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), false);
    });

    it('in General — no folder there — the picker comes at once, without the «as here» question', async () => {
      harness.isGeneral = true;
      await harness.state.removeBinding(harness.key);
      await harness.runCommand('topic', 'Release notes');
      const picker = getLastReply();
      assert.equal(picker.text, t('topic.pickFolder', { name: 'Release notes' }));
      const wizardId = getWizardId(picker);
      assert.deepEqual(harness.getKeyboardData(picker), [
        [buildTopicCreateFolderCallback(wizardId)],
        [buildTopicFolderCallback(wizardId, 0), buildTopicFolderCallback(wizardId, 1)],
        [buildTopicFolderCallback(wizardId, 2)],
        [buildTopicCancelCallback(wizardId)],
      ]);
    });

    it('an unbound topic sees the picker at once too', async () => {
      await harness.state.removeBinding(harness.key);
      await harness.runCommand('topic', 'Release notes');
      assert.equal(getLastReply().text, t('topic.pickFolder', { name: 'Release notes' }));
    });

    it('a name over 128 characters is refused and asked again; 128 is accepted', async () => {
      await harness.runCommand('topic', 'x'.repeat(topicNameMaxLength + 1));
      assert.equal(getLastReply().text, `${t('topic.nameTooLong', { max: topicNameMaxLength })}\n${t('topic.askName')}\n${t('login.esc_hint')}`);
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), true);
      await topic.submitTopicInput(harness.key, 'x'.repeat(topicNameMaxLength));
      assert.equal(getLastReply().text, t('topic.askFolder', { name: 'x'.repeat(topicNameMaxLength) }));
    });

    it('a name of whitespace only is asked for again', async () => {
      await harness.runCommand('topic');
      await topic.submitTopicInput(harness.key, '  \n ');
      assert.equal(getLastReply().text, `${t('topic.askName')}\n${t('login.esc_hint')}`);
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), true);
    });
  });

  describe('the answers', () => {
    async function askFolderOfBoundTopic(name = 'Release notes'): Promise<{ question: RecordedSend; wizardId: string }> {
      await harness.runCommand('topic', name);
      const question = getLastReply();
      return { question, wizardId: getWizardId(question) };
    }

    it('«as here» creates the topic, binds it to this folder and turns the question into the answer with the link to the topic', async () => {
      const { question, wizardId } = await askFolderOfBoundTopic();
      await harness.tapButton(question.messageId ?? 0, buildTopicSameFolderCallback(wizardId));

      assert.deepEqual(harness.fakeTelegram.createdTopics.map((created) => created.name), ['Release notes']);
      const { threadId } = harness.fakeTelegram.createdTopics[0];
      assert.deepEqual(boundTopics, [{ key: makeTelegramKey(harnessGroup.id, threadId), subdir: folderRepoName, topicName: 'Release notes' }]);
      const answer = harness.edits.at(-1);
      assert.equal(answer?.messageId, question.messageId);
      assert.equal(answer?.text, t('topic.created', { name: 'Release notes', subdir: folderRepoName }));
      assert.deepEqual(getUrlButtons(answer), [`https://t.me/c/1111111111/${threadId}`]);
      assert.deepEqual(harness.getKeyboardData(answer).flat().filter((data) => typeof data === 'string'), [], 'the choice is consumed: only the link button is left');
    });

    it('a second tap of the same keyboard makes no second topic', async () => {
      const { question, wizardId } = await askFolderOfBoundTopic();
      const tap = harness.tapButton(question.messageId ?? 0, buildTopicSameFolderCallback(wizardId));
      const secondTap = harness.tapButton(question.messageId ?? 0, buildTopicSameFolderCallback(wizardId));
      await Promise.all([tap, secondTap]);
      await harness.tapButton(question.messageId ?? 0, buildTopicSameFolderCallback(wizardId));
      assert.equal(harness.fakeTelegram.createdTopics.length, 1);
      assert.equal(boundTopics.length, 1);
    });

    it('«other folder» turns the question into the picker; a pick makes the topic on that folder', async () => {
      const { question, wizardId } = await askFolderOfBoundTopic();
      await harness.tapButton(question.messageId ?? 0, buildTopicOtherFolderCallback(wizardId));
      const picker = harness.edits.at(-1);
      assert.equal(picker?.messageId, question.messageId, 'the same message');
      assert.equal(picker?.text, t('topic.pickFolder', { name: 'Release notes' }));
      assert.deepEqual(harness.getKeyboardData(picker).flat(), [
        buildTopicCreateFolderCallback(wizardId),
        buildTopicFolderCallback(wizardId, 0), buildTopicFolderCallback(wizardId, 1), buildTopicFolderCallback(wizardId, 2),
        buildTopicCancelCallback(wizardId),
      ]);

      await harness.tapButton(question.messageId ?? 0, buildTopicFolderCallback(wizardId, 1));
      assert.deepEqual(boundTopics.map((bound) => bound.subdir), ['beta']);
      assert.equal(harness.edits.at(-1)?.text, t('topic.created', { name: 'Release notes', subdir: 'beta' }));
    });

    it('the picker pages in place: a page tap re-draws the keyboard with the list the wizard listed, indexes continuing', async () => {
      workFolders = Array.from({ length: BIND_PAGE_SIZE + 2 }, (_, index) => `folder${index.toString().padStart(2, '0')}`);
      await harness.state.removeBinding(harness.key);
      await harness.runCommand('topic', 'Release notes');
      const picker = getLastReply();
      const wizardId = getWizardId(picker);
      // The folders of a wizard are a snapshot: one created later does not shift the indexes under the keyboard.
      workFolders = ['newcomer', ...workFolders];
      const calls = harness.fakeTelegram.listCalls('editMessageReplyMarkup').length;
      await harness.tapButton(picker.messageId ?? 0, buildTopicPageCallback(wizardId, 1));
      assert.equal(harness.fakeTelegram.listCalls('editMessageReplyMarkup').length, calls + 1);
      await harness.tapButton(picker.messageId ?? 0, buildTopicFolderCallback(wizardId, BIND_PAGE_SIZE));
      assert.deepEqual(boundTopics.map((bound) => bound.subdir), [`folder${BIND_PAGE_SIZE.toString().padStart(2, '0')}`]);
    });

    it('«create new folder» turns the picker into the folder-name question; a name that is refused keeps it, a created one makes the topic', async () => {
      await harness.state.removeBinding(harness.key);
      await harness.runCommand('topic', 'Release notes');
      const picker = getLastReply();
      const wizardId = getWizardId(picker);
      await harness.tapButton(picker.messageId ?? 0, buildTopicCreateFolderCallback(wizardId));
      const prompt = harness.edits.at(-1);
      assert.equal(prompt?.text, `${t('topic.createFolderPrompt', { name: 'Release notes' })}\n${t('login.esc_hint')}`);
      assert.deepEqual(harness.getKeyboardData(prompt).flat(), [], 'the picker is consumed');
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), true);

      folderOutcome = { outcome: 'invalid' };
      await topic.submitTopicInput(harness.key, '../escape');
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), true, 'a refused name leaves the question open');
      assert.equal(harness.fakeTelegram.createdTopics.length, 0);

      folderOutcome = { outcome: 'ready', subdir: 'fresh-folder' };
      await topic.submitTopicInput(harness.key, 'fresh-folder');
      assert.deepEqual(createdFolderNames, ['../escape', 'fresh-folder']);
      assert.deepEqual(boundTopics.map((bound) => bound.subdir), ['fresh-folder']);
      assert.equal(harness.edits.at(-1)?.messageId, picker.messageId, 'the answer lands in the same message');
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), false);
    });

    it('a folder that cannot be created ends the wizard without a topic', async () => {
      await harness.state.removeBinding(harness.key);
      await harness.runCommand('topic', 'Release notes');
      const picker = getLastReply();
      const wizardId = getWizardId(picker);
      await harness.tapButton(picker.messageId ?? 0, buildTopicCreateFolderCallback(wizardId));
      folderOutcome = { outcome: 'failed' };
      await topic.submitTopicInput(harness.key, 'no-permission');
      assert.equal(harness.fakeTelegram.createdTopics.length, 0);
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), false);
    });

    it('a group without the can_manage_topics right gets the existing hint, and nothing is bound', async () => {
      harness.fakeTelegram.canManageTopics = false;
      const { question, wizardId } = await askFolderOfBoundTopic();
      await harness.tapButton(question.messageId ?? 0, buildTopicSameFolderCallback(wizardId));
      assert.equal(harness.edits.at(-1)?.text, t('error.tg.perm.manage_topics'));
      assert.deepEqual(boundTopics, []);
      assert.deepEqual(getUrlButtons(harness.edits.at(-1)), []);
    });

    it('a topic that was created but could not be bound says so — and still links to it', async () => {
      bindFailure = '❌ Folder `gone` not found.';
      const { question, wizardId } = await askFolderOfBoundTopic();
      await harness.tapButton(question.messageId ?? 0, buildTopicSameFolderCallback(wizardId));
      const answer = harness.edits.at(-1);
      assert.equal(answer?.text, t('topic.createdNotBound', { name: 'Release notes', reason: bindFailure }));
      assert.equal(getUrlButtons(answer).length, 1);
    });
  });

  describe("the wizard's lifetime", () => {
    it('any other command ends the pending name question silently, and the wizard with it', async () => {
      await harness.runCommand('topic');
      assert.equal(topic.cancelTopicInput(harness.key), true);
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), false);
      assert.equal(topic.cancelTopicInput(harness.key), false, 'nothing pending any more');
      assert.deepEqual(harness.replies.map((reply) => reply.text), [`${t('topic.askName')}\n${t('login.esc_hint')}`], 'nothing was said');
    });

    it('a command leaves a question that waits for a tap alone: its keyboard is still a valid question', async () => {
      const { question, wizardId } = await askAboutFolder();
      assert.equal(topic.cancelTopicInput(harness.key), false);
      await harness.tapButton(question.messageId ?? 0, buildTopicSameFolderCallback(wizardId));
      assert.equal(harness.fakeTelegram.createdTopics.length, 1);
    });

    it('/esc cancels the pending name question: said in a new message, since there is no message of the wizard yet', async () => {
      await harness.runCommand('topic');
      assert.equal(await topic.cancelTopicWizard(harness.key), true);
      assert.equal(getLastReply().text, t('topic.cancelled'));
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), false);
      assert.equal(await topic.cancelTopicWizard(harness.key), false, 'nothing left to cancel: /esc is the interrupt again');
    });

    it('/esc at the folder question consumes it into the notice; its buttons go stale', async () => {
      const { question, wizardId } = await askAboutFolder();
      assert.equal(await topic.cancelTopicWizard(harness.key), true);
      const notice = harness.edits.at(-1);
      assert.equal(notice?.messageId, question.messageId, 'the question message itself');
      assert.equal(notice?.text, t('topic.cancelled'));
      assert.deepEqual(harness.getKeyboardData(notice).flat(), [], 'its keyboard is dropped');
      await harness.tapButton(question.messageId ?? 0, buildTopicSameFolderCallback(wizardId));
      assert.equal(harness.fakeTelegram.createdTopics.length, 0);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), t('topic.staleChoice'));
    });

    it('/esc in the picker ends the wizard the same way', async () => {
      await harness.state.removeBinding(harness.key);
      await harness.runCommand('topic', 'Release notes');
      const picker = getLastReply();
      const wizardId = getWizardId(picker);
      assert.equal(await topic.cancelTopicWizard(harness.key), true);
      assert.equal(harness.edits.at(-1)?.text, t('topic.cancelled'));
      await harness.tapButton(picker.messageId ?? 0, buildTopicFolderCallback(wizardId, 0));
      assert.equal(harness.fakeTelegram.createdTopics.length, 0);
    });

    it('/esc during the folder-name question cancels it; the keyboards of the wizard go stale', async () => {
      await harness.state.removeBinding(harness.key);
      await harness.runCommand('topic', 'Release notes');
      const picker = getLastReply();
      const wizardId = getWizardId(picker);
      await harness.tapButton(picker.messageId ?? 0, buildTopicCreateFolderCallback(wizardId));
      assert.equal(await topic.cancelTopicWizard(harness.key), true);
      assert.equal(harness.edits.at(-1)?.text, t('topic.cancelled'), 'the folder-name question message becomes the notice');
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), false);
      await harness.tapButton(picker.messageId ?? 0, buildTopicFolderCallback(wizardId, 0));
      assert.equal(harness.fakeTelegram.createdTopics.length, 0);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), t('topic.staleChoice'));
    });

    it('the «cancel» button on the folder question and on the picker does what /esc does', async () => {
      const { question, wizardId } = await askAboutFolder();
      await harness.tapButton(question.messageId ?? 0, buildTopicCancelCallback(wizardId));
      assert.equal(harness.edits.at(-1)?.text, t('topic.cancelled'));
      assert.deepEqual(harness.getKeyboardData(harness.edits.at(-1)).flat(), []);
      assert.equal(await topic.cancelTopicWizard(harness.key), false, 'the wizard is gone');

      await harness.state.removeBinding(harness.key);
      await harness.runCommand('topic', 'Second');
      const picker = getLastReply();
      await harness.tapButton(picker.messageId ?? 0, buildTopicCancelCallback(getWizardId(picker)));
      assert.equal(harness.edits.at(-1)?.messageId, picker.messageId);
      assert.equal(harness.edits.at(-1)?.text, t('topic.cancelled'));
      assert.equal(harness.fakeTelegram.createdTopics.length, 0);
    });

    it('/esc cannot stop a topic that is being created; the tap that started it goes on', async () => {
      const { question, wizardId } = await askAboutFolder();
      let release = (): void => {};
      harness.fakeTelegram.holdNextResponse('createForumTopic', new Promise<void>((resolve) => { release = resolve; }));
      const tap = harness.tapButton(question.messageId ?? 0, buildTopicSameFolderCallback(wizardId));
      await waitFor(() => harness.fakeTelegram.createdTopics.length === 1);
      assert.equal(await topic.cancelTopicWizard(harness.key), false, 'the topic exists already: /esc is the interrupt again');
      release();
      await tap;
      assert.equal(harness.edits.at(-1)?.text, t('topic.created', { name: 'Release notes', subdir: folderRepoName }));
    });

    it('«create new folder» ends /bind\'s own folder-name question of the topic: the two would race for the next message', async () => {
      await harness.state.removeBinding(harness.key);
      await harness.runCommand('topic', 'Release notes');
      const picker = getLastReply();
      await harness.tapButton(picker.messageId ?? 0, buildTopicCreateFolderCallback(getWizardId(picker)));
      assert.deepEqual(disarmedFolderCreationKeys, [harness.key]);
    });

    it('a keyboard of another message is refused, though the wizard is alive', async () => {
      await harness.runCommand('topic', 'Release notes');
      const question = getLastReply();
      const wizardId = getWizardId(question);
      await harness.tapButton((question.messageId ?? 0) + 1, buildTopicSameFolderCallback(wizardId));
      assert.equal(harness.fakeTelegram.createdTopics.length, 0);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), t('topic.staleChoice'));
    });

    it('a wizard older than half an hour is out of date: its keyboard is refused, its name question no longer captures', async () => {
      mock.timers.enable({ apis: ['Date'], now: Date.now() });
      await harness.runCommand('topic', 'Release notes');
      const question = getLastReply();
      const wizardId = getWizardId(question);
      await harness.runCommand('topic');
      mock.timers.tick(31 * 60 * 1000);
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), false);
      await harness.tapButton(question.messageId ?? 0, buildTopicSameFolderCallback(wizardId));
      assert.equal(harness.fakeTelegram.createdTopics.length, 0);
      assert.equal(harness.fakeTelegram.callbackAnswers.at(-1), t('topic.staleChoice'));
    });

    it('a new /topic replaces the pending name question of the old one', async () => {
      await harness.runCommand('topic');
      await harness.runCommand('topic', 'Second');
      assert.equal(topic.checkIsAwaitingTopicInput(harness.key), false, 'the second run took its name from the command');
      assert.equal(getLastReply().text, t('topic.askFolder', { name: 'Second' }));
    });
  });
});
