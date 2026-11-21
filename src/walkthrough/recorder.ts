/**
 * The recorder of the walkthrough tool: a preload (`node --import tsx --import <globalTestSetup> --import <this file> --test <flow>`) that
 * watches a flow RUN and writes what a person would have seen to the file `WALKTHROUGH_OUT` names, for `renderWalkthrough.ts` to draw:
 *  - the flow's steps (every `it`, with its start and its end);
 *  - the operator's chat as the fake Bot API holds it, as it changes, and the buttons the flow taps;
 *  - what the fake agent read (its prompts), the tools it called, the answers it gave and what its hooks handed it — from the logs of the
 *    flow's instance directory (`WALKTHROUGH_LAYOUT_PREFIX`).
 * It only READS: every patched method calls the original with its own arguments and gives back its result, and nothing it writes lies
 * inside the flow's instance. A flow behaves exactly as without it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readJsonLines } from '../__tests__/e2e/isolatedCharness';
import { fakeClaudeLogFileNames, type FakeClaudeAnswer, type FakeClaudePrompt, type FakeClaudeToolCall } from '../__tests__/jiraE2e/fakeClaudeContract';
import { FakeTelegram, type FakeTelegramMessage, type TelegramUser } from '../__tests__/telegramE2e/fakeTelegram';
import { walkthroughLayoutPrefixEnvName, walkthroughOutEnvName, type RecordedMessage, type WalkthroughEvent, type WalkthroughRecording } from './walkthroughTypes';

/** How often the chat and the agent's logs are looked at. */
const pollIntervalMs = 150;

/** `mkdtemp` adds this many random characters to the prefix. */
const mkdtempSuffixLength = 6;

/** How long before the recorder started an instance directory may have been made and still be the flow's. */
const layoutCreatedBeforeStartToleranceMs = 2000;

interface FakeHookRecord {
  issueKey: string;
  additionalContext: string;
}

const outputPath = process.env[walkthroughOutEnvName];
const layoutPrefix = process.env[walkthroughLayoutPrefixEnvName];
if (outputPath === undefined || layoutPrefix === undefined) {
  throw new Error(`the recorder needs ${walkthroughOutEnvName} and ${walkthroughLayoutPrefixEnvName}: run a flow through \`yarn walkthrough record\``);
}

const recordingFilePath = outputPath;
const instanceDirPrefix = layoutPrefix;
const startedAtMs = Date.now();
const events: WalkthroughEvent[] = [];

function addEvent(event: WalkthroughEvent): void {
  events.push(event);
}

const getElapsedMs = (): number => Date.now() - startedAtMs;

function writeRecording(): void {
  const recording: WalkthroughRecording = { startedAtMs, events };
  fs.writeFileSync(recordingFilePath, JSON.stringify(recording));
}

// ── the steps: every `it` of the flow ──

const nodeTest: typeof import('node:test') = require('node:test');
const originalIt = nodeTest.it;
let stepCount = 0;

/** A test body that takes `(t, done)` is callback-style: the runner waits for `done`, which a wrapper cannot hand on. */
const callbackStyleBodyArity = 2;

function recordStep(this: unknown, name: string, ...rest: unknown[]) {
  stepCount += 1;
  const index = stepCount;
  const wrappedArguments = [...rest];
  const bodyIndex = rest.findIndex((argument) => typeof argument === 'function');
  const body = bodyIndex < 0 ? undefined : rest[bodyIndex];
  if (typeof body === 'function') {
    if (body.length >= callbackStyleBodyArity) {
      throw new Error(`the recorder cannot wrap the callback-style test "${name}" (its body takes \`done\`): rewrite it as an async body, or record another flow`);
    }
    wrappedArguments[bodyIndex] = async function recordedBody(this: unknown, ...bodyArguments: unknown[]) {
      addEvent({ kind: 'step', atMs: getElapsedMs(), index, name, phase: 'start' });
      try {
        const result = await Reflect.apply(body, this, bodyArguments);
        addEvent({ kind: 'step', atMs: getElapsedMs(), index, name, phase: 'pass' });
        return result;
      } catch (error) {
        addEvent({ kind: 'step', atMs: getElapsedMs(), index, name, phase: 'fail', error: error instanceof Error ? error.message.slice(0, 300) : 'the step failed' });
        throw error;
      }
    };
  }
  return Reflect.apply(originalIt, this, [name, ...wrappedArguments]);
}

// `it.skip` / `it.only` / `it.todo` stay what they were (they are not steps of the run, so they are not recorded).
Object.defineProperty(nodeTest, 'it', { configurable: true, writable: true, value: Object.assign(recordStep, originalIt) });

// ── the agent's logs: the flow's instance directory, found by its prefix ──

let agentLogDir: string | null = null;

function findAgentLogDir(): string | null {
  const root = os.tmpdir();
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith(instanceDirPrefix) || name.length !== instanceDirPrefix.length + mkdtempSuffixLength) continue;
    const directory = path.join(root, name);
    if (fs.statSync(directory).birthtimeMs < startedAtMs - layoutCreatedBeforeStartToleranceMs) continue;
    const logDir = path.join(directory, 'fake-claude-log');
    if (fs.existsSync(logDir)) return logDir;
  }
  return null;
}

/** How many records of each log were already turned into events. */
const consumedRecordCounts = new Map<string, number>();

function readNewRecords<TRecord>(logDir: string, fileName: string): TRecord[] {
  const records = readJsonLines<TRecord>(path.join(logDir, fileName));
  const consumed = consumedRecordCounts.get(fileName) ?? 0;
  consumedRecordCounts.set(fileName, records.length);
  return records.slice(consumed);
}

function recordAgentLogs(): void {
  agentLogDir ??= findAgentLogDir();
  if (agentLogDir === null) return;
  for (const prompt of readNewRecords<FakeClaudePrompt>(agentLogDir, fakeClaudeLogFileNames.prompts)) addEvent({ kind: 'prompt', atMs: getElapsedMs(), issueKey: prompt.issueKey, text: prompt.text });
  for (const hook of readNewRecords<FakeHookRecord>(agentLogDir, fakeClaudeLogFileNames.hooks)) addEvent({ kind: 'hook', atMs: getElapsedMs(), issueKey: hook.issueKey, text: hook.additionalContext });
  for (const call of readNewRecords<FakeClaudeToolCall>(agentLogDir, fakeClaudeLogFileNames.toolCalls)) addEvent({ kind: 'tool', atMs: getElapsedMs(), issueKey: call.issueKey, tool: call.tool, outcome: call.outcome });
  for (const answer of readNewRecords<FakeClaudeAnswer>(agentLogDir, fakeClaudeLogFileNames.answers)) addEvent({ kind: 'answer', atMs: getElapsedMs(), issueKey: answer.issueKey, answerKind: answer.kind, outcome: answer.outcome });
}

// ── the operator's chat: the fake Bot API's messages, whenever they change ──

function toRecordedMessage(message: FakeTelegramMessage): RecordedMessage {
  return {
    id: message.message_id,
    thread: message.message_thread_id ?? 0,
    isBot: message.from.is_bot,
    text: message.text,
    keyboard: (message.reply_markup?.inline_keyboard ?? []).map((row) => row.map((button) => ({ text: button.text, data: 'callback_data' in button ? button.callback_data : undefined }))),
  };
}

let lastChatSnapshot = '';

function recordChat(fake: FakeTelegram): void {
  const messages = fake.listAllMessages().filter((message) => !message.isDeleted && message.text !== '').map(toRecordedMessage);
  const snapshot = JSON.stringify(messages);
  if (snapshot === lastChatSnapshot) return;
  lastChatSnapshot = snapshot;
  addEvent({ kind: 'chat', atMs: getElapsedMs(), messages });
}

let pollTimer: NodeJS.Timeout | null = null;

const originalStart = FakeTelegram.prototype.start;
FakeTelegram.prototype.start = async function startRecording(this: FakeTelegram): Promise<string> {
  const apiRoot = await originalStart.call(this);
  pollTimer = setInterval(() => {
    recordChat(this);
    recordAgentLogs();
  }, pollIntervalMs);
  pollTimer.unref();
  return apiRoot;
};

const originalStop = FakeTelegram.prototype.stop;
FakeTelegram.prototype.stop = async function stopRecording(this: FakeTelegram): Promise<void> {
  recordChat(this);
  recordAgentLogs();
  if (pollTimer !== null) clearInterval(pollTimer);
  writeRecording();
  await originalStop.call(this);
};

const originalPushCallback = FakeTelegram.prototype.pushCallback;
FakeTelegram.prototype.pushCallback = function pushCallbackRecording(this: FakeTelegram, messageId: number, callbackData: string, from?: TelegramUser): void {
  addEvent({ kind: 'tap', atMs: getElapsedMs(), messageId, data: callbackData });
  originalPushCallback.call(this, messageId, callbackData, from);
};

process.on('exit', writeRecording);
