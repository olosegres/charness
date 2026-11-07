/**
 * @description What the AGENT is told about HOW a Telegram message arrived — that it was a reply to an earlier message, that
 * it was forwarded from somewhere else — at PROCESS level: the BUILT charness started the way an isolated instance is
 * (`scripts/run-isolated.sh`) against the fake Bot API (`telegramE2e/fakeTelegram.ts`), a fake speech engine for the voice
 * path and the fake agent (`jiraE2e/fakeClaude.ts`), which logs every user message it reads, whole. The prompts are read
 * from that log — what the agent really got, not what the bot meant to send. One flow, in order:
 *
 *   boot → a topic is bound, the agent is started, and it answers a first message (the bot message to reply to)
 *   → a TYPED reply to that answer: the agent reads the reply-quote block (`from: assistant`) ahead of the words
 *   → a VOICE note sent as a reply to the same answer: the very same block ahead of the transcript
 *   → a VOICE note sent as a reply to the operator's own earlier message: the block names a user, quoting that message
 *   → a FORWARDED text (from a channel): the agent reads the forwarded mark — who first wrote it and when — ahead of the text
 *   → a FORWARDED voice note (from a person): the same mark ahead of the transcript
 *   → a BURST — two forwarded texts and then the operator's own words, back to back: three prompts, each forwarded one
 *     marked with ITS OWN origin, the operator's own unmarked
 *   → a FORWARDED bot command (`/quit now`): it is content — no agent is stopped, the agent reads it marked, and the next plain
 *     message is read by the very same process
 *   → a FORWARDED slash command the bot does not own (`/review the diff`): the agent reads it marked, not as a command of the
 *     operator's own
 *   → a FORWARDED document and a FORWARDED photo, each with a caption: the file announcement the agent reads (saved path, caption)
 *     leads with the mark; the same photo sent plainly has none
 *   → a pending question and a bare digit: typed, the digit answers the question; FORWARDED, it does not — the question is
 *     given up unanswered and the agent reads the digit marked
 *   → a plain text and a plain voice note: no block of either kind.
 *
 * What the unit tests cover instead: the block and the mark themselves (`replyQuote.test.ts`, `forwardedMark.test.ts`),
 * reading them off each kind of Telegram message (`telegramInbound.test.ts`), the fold rule (`messageContext.test.ts`), and
 * that every route a prompt takes — the startup buffer, a file, an album — folds the block (`replyQuoteWiring.test.ts`).
 *
 * Nothing leaves the machine: the Bot API and the speech engine are on loopback and the agent is a fake. Everything the test
 * starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeSpeechEngine } from './telegramE2e/fakeSpeechEngine';
import { FakeTelegram, type FakeForwardOrigin, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeAskNoAnswerOutcome, fakeAskQuestion, fakeAskToolName, fakeClaudeLogFileNames, type FakeClaudePrompt, type FakeClaudeToolCall } from './jiraE2e/fakeClaudeContract';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  IsolatedCharness,
  listTmuxSessions,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 241;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'context-proj';
const voiceFileId = 'voice-context-1';
const voiceFileBytes = 2048;
const documentFileId = 'document-context-1';
const photoFileId = 'photo-context-1';
const plainPhotoFileId = 'photo-context-2';
const attachmentFileBytes = 1024;
const forwardedDocumentCaption = 'the disk alert, as a file';
const forwardedPhotoCaption = 'the dashboard at the moment of the alert';
const plainPhotoCaption = 'my own screenshot';
const voiceDurationSeconds = 2;

const replyTimeoutMs = 20 * 1000;

/** What the fake speech engine «recognises», in the order the flow sends its voice notes. */
const spokenTranscripts = ['Please explain that', 'And what about this one', 'Treat this as an example', 'Just a plain spoken line'];

/** When the forwarded messages were ORIGINALLY sent (unix seconds): a fixed, past instant. */
const originalSentAtSeconds = Math.floor(Date.UTC(2026, 10, 6, 14, 20, 0) / 1000);
const burstFirstSentAtSeconds = originalSentAtSeconds + 60;
const burstSecondSentAtSeconds = originalSentAtSeconds + 120;

const channelOrigin: FakeForwardOrigin = {
  type: 'channel',
  chat: { id: -1005550000002, type: 'channel', title: 'Ops Alerts' },
  message_id: 9,
  date: originalSentAtSeconds,
};
const personOrigin: FakeForwardOrigin = {
  type: 'user',
  sender_user: { id: 555, is_bot: false, first_name: 'Alice', username: 'alice' },
  date: originalSentAtSeconds,
};
const hiddenOrigin: FakeForwardOrigin = { type: 'hidden_user', sender_user_name: 'Jane Doe', date: burstFirstSentAtSeconds };
const groupOrigin: FakeForwardOrigin = {
  type: 'chat',
  sender_chat: { id: -1005550000003, type: 'supergroup', title: 'Team room' },
  author_signature: 'Chief',
  date: burstSecondSentAtSeconds,
};

const forwardedAlertText = 'ALERT: disk 91% on web-1';
const forwardedQuitText = '/quit now';
const afterForwardedQuitText = 'still here after the forward';
const forwardedSlashText = '/review the diff';
const burstFirstText = 'ALERT: queue is stuck';
const burstSecondText = 'We deploy at noon';
const ownBurstText = 'these three are only examples';
const typedReplyText = 'why did it end like that?';
const earlierOperatorText = 'start with the config';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let speechEngine: FakeSpeechEngine;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** The agent's answer the replies are made to, and the operator's own earlier message. */
let agentAnswer: FakeTelegramMessage;
let earlierOperatorMessageId = 0;

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

/** Every user message the fake agent read so far, oldest first, with its whole text. */
function readAgentPrompts(): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts));
}

/** The first prompt the agent read that `check` accepts; waits for it. */
async function waitForAgentPromptMatching(description: string, check: (prompt: FakeClaudePrompt) => boolean): Promise<FakeClaudePrompt> {
  let found: FakeClaudePrompt | undefined;
  await getCharness().waitFor(`the agent to read ${description}`, replyTimeoutMs, () => {
    found = readAgentPrompts().find(check);
    return found !== undefined;
  });
  if (!found) throw new Error(`the agent never read ${description}`);
  return found;
}

/** The prompt the agent read that carries `words` (the operator's text or a transcript); waits for it. */
async function waitForAgentPrompt(words: string): Promise<FakeClaudePrompt> {
  return waitForAgentPromptMatching(`«${words}»`, (prompt) => prompt.text.includes(words));
}

/** What the agent was told each `AskUserQuestion` it put came back with, in order. */
function readAskOutcomes(): string[] {
  return readJsonLines<FakeClaudeToolCall>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls)).filter((call) => call.tool === fakeAskToolName).map((call) => call.outcome);
}

/** The agent puts a question to the topic (the fake's `ask` mode); resolves the question's message once it is on screen. */
async function putQuestionToTopic(label: string): Promise<FakeTelegramMessage> {
  const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${label} [fake:ask] ask me something`);
  return topic.waitForMessage(`the question of ${label}`, (message) => message.message_id > sentMessageId && message.text.includes(fakeAskQuestion.question) && message.reply_markup !== undefined);
}

/** The reply-quote block the agent is owed for a reply to a message with this text, from the bot (`assistant`) or a person (`user`). */
function getExpectedReplyBlock(from: 'assistant' | 'user', quotedText: string): string {
  return [`[Replying to an earlier message · from: ${from}]`, ...quotedText.split('\n').map((line) => `> ${line}`)].join('\n');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The forwarded mark the agent is owed, with the original date left to be read back: `originOf` is what follows «from: »,
 * and the instant in the mark must be `sentAtSeconds` (whatever offset the instance writes it in).
 */
function assertForwardedMarkLeads(prompt: FakeClaudePrompt, originOf: string, sentAtSeconds: number, words: string): void {
  const markRe = new RegExp(`\\[Forwarded message · from: ${escapeRegExp(originOf)} · originally sent: (\\S+)\\]\\n\\n${escapeRegExp(words)}`);
  const match = markRe.exec(prompt.text);
  assert.ok(match, `the mark of «${originOf}» must lead «${words}» in:\n${prompt.text}`);
  assert.equal(Date.parse(match[1]), sentAtSeconds * 1000, 'the mark carries the ORIGINAL send time, as an offset-aware ISO instant');
}

describe('message context end to end: built charness, fake Bot API, fake speech engine, fake agent', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-context-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    speechEngine = new FakeSpeechEngine((requestIndex) => ({ status: 200, text: spokenTranscripts[requestIndex] ?? 'unexpected extra voice note' }));
    const speechUrl = await speechEngine.start();
    // The voice settings the way an operator keeps them, beside the instance's env file: one engine, a loopback server.
    fs.writeFileSync(path.join(path.dirname(layout.envFile), 'stt.json'), `${JSON.stringify({ engines: [{ id: 'u1', kind: 'url', url: speechUrl }] }, null, 2)}\n`);
    fakeTelegram.registerFile(voiceFileId, Buffer.alloc(voiceFileBytes, 7));
    for (const fileId of [documentFileId, photoFileId, plainPhotoFileId]) fakeTelegram.registerFile(fileId, Buffer.alloc(attachmentFileBytes, 9));
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      CONNECTORS: 'telegram',
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_SOCKET_NAME: layout.tmuxSocketName,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    await speechEngine?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots, binds the topic, starts the agent, and the agent answers a first message', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('claude', 'ready in');

    earlierOperatorMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, earlierOperatorText);
    await waitForAgentPrompt(earlierOperatorText);
    agentAnswer = await topic.waitForMessage('the agent\'s answer to the first message', (message) => message.message_id > earlierOperatorMessageId);
    assert.ok(agentAnswer.text.length > 0, 'the agent\'s answer has words to quote');
  });

  it('a typed reply to the agent\'s answer reaches the agent with the reply-quote block (the baseline)', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, typedReplyText, { replyToMessageId: agentAnswer.message_id });
    const prompt = await waitForAgentPrompt(typedReplyText);
    assert.ok(
      prompt.text.includes(`${getExpectedReplyBlock('assistant', agentAnswer.text)}\n\n${typedReplyText}`),
      `the quote of the answer must lead the words in:\n${prompt.text}`,
    );
    assert.ok(!prompt.text.includes('[Forwarded message'), 'a reply that was not forwarded carries no forwarded mark');
  });

  it('a voice note sent as a reply to the agent\'s answer reaches the agent with the SAME block, ahead of the transcript', async () => {
    const voiceMessageId = fakeTelegram.pushOperatorVoice(topicThreadId, voiceFileId, voiceDurationSeconds, { replyToMessageId: agentAnswer.message_id });
    await topic.waitForMessage('the transcript echo', (message) => message.message_id > voiceMessageId && message.text === `🎤 ${spokenTranscripts[0]}`);
    const prompt = await waitForAgentPrompt(spokenTranscripts[0]);
    assert.ok(
      prompt.text.includes(`${getExpectedReplyBlock('assistant', agentAnswer.text)}\n\n${spokenTranscripts[0]}`),
      `the very block a typed reply gets must lead the transcript in:\n${prompt.text}`,
    );
    assert.ok(!prompt.text.includes('[Forwarded message'), 'a reply that was not forwarded carries no forwarded mark');
  });

  it('a voice note sent as a reply to the operator\'s own message carries the block naming a user, quoting that message', async () => {
    const voiceMessageId = fakeTelegram.pushOperatorVoice(topicThreadId, voiceFileId, voiceDurationSeconds, { replyToMessageId: earlierOperatorMessageId });
    await topic.waitForMessage('the transcript echo', (message) => message.message_id > voiceMessageId && message.text === `🎤 ${spokenTranscripts[1]}`);
    const prompt = await waitForAgentPrompt(spokenTranscripts[1]);
    assert.ok(
      prompt.text.includes(`${getExpectedReplyBlock('user', earlierOperatorText)}\n\n${spokenTranscripts[1]}`),
      `the quote of the operator's message must lead the transcript in:\n${prompt.text}`,
    );
  });

  it('a forwarded text reaches the agent marked: who first wrote it and when, ahead of the text', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, forwardedAlertText, { forwardOrigin: channelOrigin });
    const prompt = await waitForAgentPrompt(forwardedAlertText);
    assertForwardedMarkLeads(prompt, 'channel "Ops Alerts"', originalSentAtSeconds, forwardedAlertText);
    assert.ok(!prompt.text.includes('[Replying to an earlier message'), 'a forward that was not a reply carries no reply quote');
  });

  it('a forwarded voice note reaches the agent marked, ahead of the transcript', async () => {
    const voiceMessageId = fakeTelegram.pushOperatorVoice(topicThreadId, voiceFileId, voiceDurationSeconds, { forwardOrigin: personOrigin });
    await topic.waitForMessage('the transcript echo', (message) => message.message_id > voiceMessageId && message.text === `🎤 ${spokenTranscripts[2]}`);
    const prompt = await waitForAgentPrompt(spokenTranscripts[2]);
    assertForwardedMarkLeads(prompt, 'user "Alice" (@alice)', originalSentAtSeconds, spokenTranscripts[2]);
  });

  it('a burst of two forwarded texts and the operator\'s own words: each forwarded one is marked with its own origin, the own words are not', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, burstFirstText, { forwardOrigin: hiddenOrigin });
    fakeTelegram.pushOperatorMessage(topicThreadId, burstSecondText, { forwardOrigin: groupOrigin });
    fakeTelegram.pushOperatorMessage(topicThreadId, ownBurstText);
    const first = await waitForAgentPrompt(burstFirstText);
    const second = await waitForAgentPrompt(burstSecondText);
    const own = await waitForAgentPrompt(ownBurstText);

    assertForwardedMarkLeads(first, 'hidden user "Jane Doe"', burstFirstSentAtSeconds, burstFirstText);
    assertForwardedMarkLeads(second, 'chat "Team room" (signed "Chief")', burstSecondSentAtSeconds, burstSecondText);
    assert.ok(!first.text.includes('Team room') && !second.text.includes('Jane Doe'), 'each forwarded part carries its own origin only');
    assert.ok(!own.text.includes('[Forwarded message'), `the operator's own words carry no mark in:\n${own.text}`);
    assert.ok(own.readAt >= second.readAt && second.readAt >= first.readAt, 'the parts reach the agent in the order they were sent');
  });

  it('a forwarded bot command is content: it stops no agent, and the agent reads it marked', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, forwardedQuitText, { forwardOrigin: personOrigin });
    const forwarded = await waitForAgentPrompt(forwardedQuitText);
    assertForwardedMarkLeads(forwarded, 'user "Alice" (@alice)', originalSentAtSeconds, forwardedQuitText);
    // The same words typed would have stopped the agent: the next plain message is read by the very process that read the forward.
    fakeTelegram.pushOperatorMessage(topicThreadId, afterForwardedQuitText);
    const next = await waitForAgentPrompt(afterForwardedQuitText);
    assert.equal(next.pid, forwarded.pid, 'the agent was not stopped by a forwarded /quit');
  });

  it('a forwarded slash command the bot does not own reaches the agent marked, not as a command of the operator\'s own', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, forwardedSlashText, { forwardOrigin: channelOrigin });
    const prompt = await waitForAgentPrompt(forwardedSlashText);
    assertForwardedMarkLeads(prompt, 'channel "Ops Alerts"', originalSentAtSeconds, forwardedSlashText);
  });

  it('a bare digit answers a pending question when the operator types it, and does not when it is forwarded', async () => {
    const outcomesBefore = readAskOutcomes().length;
    await putQuestionToTopic('ASKTYPED');
    fakeTelegram.pushOperatorMessage(topicThreadId, '1');
    await getCharness().waitFor('the typed digit to answer the question', replyTimeoutMs, () => readAskOutcomes().length > outcomesBefore);
    assert.equal(readAskOutcomes()[outcomesBefore], fakeAskQuestion.shortOptionLabel, 'the typed 1 picked the first option');

    await putQuestionToTopic('ASKFORWARDED');
    fakeTelegram.pushOperatorMessage(topicThreadId, '1', { forwardOrigin: personOrigin });
    const prompt = await waitForAgentPromptMatching('the forwarded digit, marked', (candidate) => /originally sent: \S+\]\n\n1(\n|$)/.test(candidate.text));
    assertForwardedMarkLeads(prompt, 'user "Alice" (@alice)', originalSentAtSeconds, '1');
    await getCharness().waitFor('the question to be given up', replyTimeoutMs, () => readAskOutcomes().length > outcomesBefore + 1);
    assert.equal(readAskOutcomes()[outcomesBefore + 1], fakeAskNoAnswerOutcome, 'the forwarded 1 answered nothing');
  });

  it('a forwarded document and a forwarded photo reach the agent marked: the mark leads the file announcement, then comes the caption', async () => {
    fakeTelegram.pushOperatorFile(topicThreadId, 'document', documentFileId, { fileName: 'disk-alert.txt', caption: forwardedDocumentCaption, forwardOrigin: channelOrigin });
    const document = await waitForAgentPrompt(forwardedDocumentCaption);
    assertForwardedMarkLeads(document, 'channel "Ops Alerts"', originalSentAtSeconds, '[Telegram file] document saved to: ');
    assert.match(document.text, new RegExp(`\\[Telegram file\\] document saved to: [^\\n]+\\n${forwardedDocumentCaption}`), 'the announcement is followed by the caption');

    fakeTelegram.pushOperatorFile(topicThreadId, 'photo', photoFileId, { caption: forwardedPhotoCaption, forwardOrigin: personOrigin });
    const photo = await waitForAgentPrompt(forwardedPhotoCaption);
    assertForwardedMarkLeads(photo, 'user "Alice" (@alice)', originalSentAtSeconds, '[Telegram file] photo saved to: ');

    fakeTelegram.pushOperatorFile(topicThreadId, 'photo', plainPhotoFileId, { caption: plainPhotoCaption });
    const plain = await waitForAgentPrompt(plainPhotoCaption);
    assert.ok(plain.text.includes('[Telegram file] photo saved to: ') && !plain.text.includes('[Forwarded message'), `a photo sent plainly carries no mark in:\n${plain.text}`);
  });

  it('a plain text and a plain voice note carry neither a reply quote nor a forwarded mark', async () => {
    const plainText = 'just a plain message';
    fakeTelegram.pushOperatorMessage(topicThreadId, plainText);
    const plainTextPrompt = await waitForAgentPrompt(plainText);
    const voiceMessageId = fakeTelegram.pushOperatorVoice(topicThreadId, voiceFileId, voiceDurationSeconds);
    await topic.waitForMessage('the transcript echo', (message) => message.message_id > voiceMessageId && message.text === `🎤 ${spokenTranscripts[3]}`);
    const plainVoicePrompt = await waitForAgentPrompt(spokenTranscripts[3]);
    for (const prompt of [plainTextPrompt, plainVoicePrompt]) {
      assert.ok(!prompt.text.includes('[Forwarded message') && !prompt.text.includes('[Replying to an earlier message'), prompt.text);
    }
    assert.equal(speechEngine.requests.length, spokenTranscripts.length, 'exactly the voice notes of the flow went through the speech engine');
  });
});
