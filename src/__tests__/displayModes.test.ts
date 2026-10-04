/**
 * @description The display-mode commands (`connectors/telegram/commands/displayModes.ts`) wired to
 * ports: a real telegraf instance against the fake Bot API, the real state store, and recording
 * stand-ins for the topic sends. Two things are pinned:
 *
 *   • WIRING — which commands and which buttons the module registers, and in which order (a
 *     telegraf `action` earlier in the chain would shadow a later one with an overlapping pattern);
 *   • BEHAVIOUR through that wiring — a typed mode and a button tap persist per topic, a tap
 *     answers its callback and re-renders the picker's keyboard, and a view that turns requests
 *     off closes the topic's open request.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Telegraf } from 'telegraf';
import { createDisplayModes, formatTopicView } from '../connectors/telegram/commands/displayModes';
import type { CommandContext, RegisterCommand } from '../connectors/telegram/commands/botCore';
import type { InboundCommand } from '../platform/inbound';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { SessionKey } from '../sessionKey';
import { getStateStore, type StateStore } from '../state';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true as const, first_name: 'Fake bot', username: 'fake_charness_bot' };
const key: SessionKey = makeTelegramKey(group.id, topicThreadId);
const expectedCommandNames = ['thinking', 'tool_results', 'subagent', 'verbosity'];
const expectedActionPatterns = ['/^think_(.+)$/', '/^toolres_(.+)$/', '/^subag_(.+)$/', '/^verb_(.+)$/', '/^view_(.+)$/'];
const waitStepMs = 25;
const waitTimeoutMs = 10_000;

type CommandHandler = Parameters<RegisterCommand>[1];

interface SentReply {
  text: string;
  extra: object | undefined;
}

let fakeTelegram: FakeTelegram;
let bot: Telegraf;
let state: StateStore;
const commandHandlers = new Map<string, CommandHandler>();
const registeredCommandNames: string[] = [];
const registeredActionPatterns: string[] = [];
const replies: SentReply[] = [];
const cancelledRequestKeys: SessionKey[] = [];
let callbackSequence = 0;

/** The part of a command's context the display-mode handlers never read. */
const unusedCommandContext = {} as CommandContext;

function getCommandHandler(name: string): CommandHandler {
  const handler = commandHandlers.get(name);
  if (!handler) throw new Error(`/${name} is not registered`);
  return handler;
}

async function runCommand(name: string, argsText: string): Promise<void> {
  const parsed: InboundCommand = { name, args: argsText ? argsText.split(' ') : [], argsText };
  await getCommandHandler(name)(unusedCommandContext, key, parsed);
}

async function waitUntil(description: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, waitStepMs));
  }
}

/** A button tap on `message`, fed through telegraf's own middleware chain. */
async function tapButton(message: FakeTelegramMessage, callbackData: string): Promise<void> {
  callbackSequence += 1;
  await bot.handleUpdate({
    update_id: callbackSequence,
    callback_query: {
      id: callbackSequence.toString(),
      from: operator,
      message,
      chat_instance: 'fake-chat-instance',
      data: callbackData,
    },
  });
}

describe('displayModes: the display-mode commands over their ports', () => {
  before(async () => {
    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    const apiRoot = await fakeTelegram.start();
    bot = new Telegraf('1000000001:fake-token-for-the-loopback-bot-api', { telegram: { apiRoot } });
    bot.botInfo = { ...botUser, can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
    state = await getStateStore();

    const originalAction = bot.action.bind(bot);
    bot.action = (...args: Parameters<Telegraf['action']>) => {
      registeredActionPatterns.push(String(args[0]));
      return originalAction(...args);
    };
    const displayModes = createDisplayModes({
      bot,
      command: (name, handler) => {
        for (const commandName of [name].flat()) {
          registeredCommandNames.push(commandName);
          commandHandlers.set(commandName, handler);
        }
      },
      getState: () => state,
      replyToThread: async (_key, text, extra) => {
        replies.push({ text, extra });
        return replies.length;
      },
      authoriseContext: async () => key,
      cancelConversationRequest: (cancelledKey) => {
        cancelledRequestKeys.push(cancelledKey);
      },
    });
    displayModes.registerDisplayModeCommands();
    displayModes.registerDisplayModeCallbacks();
  });

  after(async () => {
    await fakeTelegram.stop();
  });

  it('registers its four commands and its five buttons, in the order the bot has always had', () => {
    assert.deepEqual(registeredCommandNames, expectedCommandNames);
    assert.deepEqual(registeredActionPatterns, expectedActionPatterns);
  });

  it('a typed mode persists per topic and is acknowledged; an unknown word is refused', async () => {
    await runCommand('thinking', 'full');
    assert.equal(state.getDisplayPrefs(key).thinking, 'full');
    assert.match(replies.at(-1)?.text ?? '', /Thinking mode: full/);

    await runCommand('tool_results', 'short');
    assert.equal(state.getDisplayPrefs(key).toolResults, 'short');
    await runCommand('subagent', 'short');
    assert.equal(state.getDisplayPrefs(key).subagent, 'short');

    const repliesBefore = replies.length;
    await runCommand('thinking', 'loud');
    assert.equal(replies.length, repliesBefore + 1);
    assert.match(replies.at(-1)?.text ?? '', /`loud` is not valid/);
    assert.equal(state.getDisplayPrefs(key).thinking, 'full', 'a refused word changes nothing');
  });

  it('/verbosity with a level writes all three preferences; with a view it writes the view', async () => {
    await runCommand('verbosity', 'minimal');
    const prefs = state.getDisplayPrefs(key);
    assert.deepEqual([prefs.thinking, prefs.toolResults, prefs.subagent], ['minimal', 'minimal', 'minimal']);

    await runCommand('verbosity', 'answers');
    assert.equal(state.getDisplayPrefs(key).view, 'answers');
    assert.match(replies.at(-1)?.text ?? '', new RegExp(formatTopicView('answers')));
  });

  it('a tap on a mode button persists it, answers the tap and re-renders the picker with the ✓ moved', async () => {
    const picker = fakeTelegram.pushOperatorMessage(topicThreadId, 'picker');
    const pickerMessage = fakeTelegram.getMessage(picker);
    assert.ok(pickerMessage);
    const answersBefore = fakeTelegram.callbackAnswers.length;

    await tapButton(pickerMessage, 'think_short');
    assert.equal(state.getDisplayPrefs(key).thinking, 'short');
    assert.equal(fakeTelegram.callbackAnswers.length, answersBefore + 1, 'the tap was answered');
    await waitUntil('the picker keyboard to be re-rendered', () => (fakeTelegram.getMessage(picker)?.reply_markup?.inline_keyboard[0] ?? []).length === 3);
    const labels = fakeTelegram.getMessage(picker)?.reply_markup?.inline_keyboard[0].map((button) => button.text);
    assert.deepEqual(labels, ['minimal', 'short ✓', 'full']);
  });

  it('a tap with an unknown mode is answered as an error and changes nothing', async () => {
    const message = fakeTelegram.getMessage(fakeTelegram.pushOperatorMessage(topicThreadId, 'picker 2'));
    assert.ok(message);
    const answersBefore = fakeTelegram.callbackAnswers.length;
    await tapButton(message, 'think_loud');
    assert.equal(fakeTelegram.callbackAnswers.length, answersBefore + 1);
    assert.match(fakeTelegram.callbackAnswers.at(-1) ?? '', /^Error:/);
    assert.equal(state.getDisplayPrefs(key).thinking, 'short');
  });

  it('switching the view to the full stream closes the topic\'s open request; a view with requests on does not', async () => {
    const message = fakeTelegram.getMessage(fakeTelegram.pushOperatorMessage(topicThreadId, 'picker 3'));
    assert.ok(message);

    await tapButton(message, 'view_streamAnswers');
    assert.equal(state.getDisplayPrefs(key).view, 'streamAnswers');
    assert.deepEqual(cancelledRequestKeys, [], 'requests stay on: nothing is cancelled');

    await tapButton(message, 'view_stream');
    assert.equal(state.getDisplayPrefs(key).view, 'stream');
    assert.deepEqual(cancelledRequestKeys, [key]);
  });
});
