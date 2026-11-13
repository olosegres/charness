/**
 * @description A Bot API connection that was closed under the bot, at PROCESS level: the BUILT charness started the way an
 * isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`. The bot keeps
 * its connections to the Bot API pooled; the real server closes an idle one after a while, and a bot that was starved of CPU
 * for longer (a loaded host) writes its next request onto a pooled connection that is already closed. The request is never
 * processed, and the message it carried used to be lost — a send is not retried when its outcome is unknown, but here it is
 * known: nothing was applied. One flow, in order:
 *
 *   boot → a topic bound
 *   → a command is answered; its reply leaves a pooled connection behind
 *   → the fake hangs up on the NEXT send that rides a pooled connection, without processing it
 *     (`dropNextReusedConnectionRequest`: what the client sees of a connection closed a moment before its request landed)
 *   → the next command's reply still reaches the topic, ONCE, and the bot says it retried on a fresh connection
 *   → a command after it is answered as usual, so the bot did not stall on the failure and no second copy of the reply came
 *   → the same for a reply made through the client Telegraf builds for ONE update (`ctx.*`: the `/language` picker's
 *     confirmation edit): the fake hangs up on it, and the picker still loses its keyboard, once.
 *
 * Closing a connection under a client that is NOT starved is harmless — it sees the close at once and drops the connection
 * from its pool —, so the real idle close (`keepAliveTimeoutMs`) with a stalled client is `botApiConnectionStall.test.ts`'s.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getUnservedPort,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import { reusedConnectionRetryLogPrefix } from '../connectors/telegram/botApiConnection';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 171;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const topicFolder = 'stale-connection-flow';
const launchLine = 'Launching Telegraf bot (long polling';
/** A read-only screen the bot answers with ONE message, whatever the topic holds. */
const voiceScreenCommand = '/stt';
const voiceScreenMark = '🎙 Voice recognition';
/** The `/language` picker: a tap on its «Auto» row is answered, then the picker is edited into a confirmation by `ctx.editMessageText`. */
const languagePickerCommand = '/language';
const languagePickerMark = '🌐 Language:';
const languageAutoButtonLabel = '✓ 🌐 Auto';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

describe('A send on a pooled Bot API connection that was closed under the bot, end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-stale-conn-', [topicFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots, binds the topic and answers a command, which leaves a pooled connection behind', async () => {
    charness = new IsolatedCharness(getLayout());
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
    await topic.sendAndAwaitReply(`/bind ${topicFolder}`, `Bound to \`${topicFolder}\``);
    await topic.sendAndAwaitReply(voiceScreenCommand, voiceScreenMark);
    assert.deepEqual(fakeTelegram.droppedRequests, [], 'nothing was hung up on yet');
  });

  it('a reply whose connection the Bot API drops still reaches the topic once, and the bot says it retried', async () => {
    fakeTelegram.dropNextReusedConnectionRequest('sendMessage');
    const commandMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, voiceScreenCommand);
    await getCharness().waitFor('the fake to hang up on a pooled connection', replyTimeoutMs, () => fakeTelegram.droppedRequests.length === 1);
    // If the drop never fired, the reply went out on a fresh connection and this test proved nothing: say so, not "no reply".
    assert.deepEqual(fakeTelegram.droppedRequests, ['sendMessage']);
    const reply = await topic.waitForMessage('the reply that rode the dropped connection', (message) => message.message_id > commandMessageId && message.text.includes(voiceScreenMark));
    assert.ok(getCharness().output.includes(reusedConnectionRetryLogPrefix), 'the bot logged the retry on a fresh connection');

    // The pacer releases sends first come first served: a command answered after the reply proves no copy of it is still on its way.
    const barrierCommandId = fakeTelegram.pushOperatorMessage(topicThreadId, voiceScreenCommand);
    await topic.waitForMessage('the answer to the command after it', (message) => message.message_id > barrierCommandId && message.text.includes(voiceScreenMark));
    const replies = topic.listMessages().filter((message) => message.message_id > commandMessageId && message.message_id < barrierCommandId && message.text.includes(voiceScreenMark));
    assert.deepEqual(replies.map((message) => message.message_id), [reply.message_id], 'the reply is in the topic exactly once');
    assert.deepEqual(fakeTelegram.droppedRequests, ['sendMessage'], 'only the one request was hung up on');
  });

  it('a picker confirmation made through the per-update client (ctx.editMessageText) survives a dropped pooled connection, once', async () => {
    const picker = await topic.sendAndAwaitReply(languagePickerCommand, languagePickerMark);
    assert.ok(picker.reply_markup, 'the picker carries its keyboard');
    const droppedBefore = fakeTelegram.droppedRequests.length;
    fakeTelegram.dropNextReusedConnectionRequest('editMessageText');

    // The tap is answered (`ctx.answerCbQuery`), which leaves a pooled connection; the edit then rides it and is hung up on.
    await topic.tapAndAwaitAnswer(picker, topic.getButtonData(picker, languageAutoButtonLabel));
    await getCharness().waitFor('the fake to hang up on the picker edit', replyTimeoutMs, () => fakeTelegram.droppedRequests.length === droppedBefore + 1);
    assert.equal(fakeTelegram.droppedRequests[droppedBefore], 'editMessageText', 'the hung-up request was the edit, not something else');
    await getCharness().waitFor('the picker to lose its keyboard', replyTimeoutMs, () => picker.reply_markup === undefined);

    // A command answered afterwards proves no second edit of the picker is still on its way.
    await topic.sendAndAwaitReply(voiceScreenCommand, voiceScreenMark);
    const pickerEdits = fakeTelegram.listCalls('editMessageText').filter((call) => call.payload.message_id === picker.message_id);
    assert.equal(pickerEdits.length, 1, 'the picker was edited exactly once');
    assert.ok(getCharness().output.includes(`${reusedConnectionRetryLogPrefix} (editMessageText)`), 'the bot logged the retry of the edit');
  });
});
