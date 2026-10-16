/**
 * @description The voice settings at BOOT, at process level: the BUILT charness started the way an isolated
 * instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`. What
 * `telegramCommandsE2e.test.ts` cannot show, because it boots once with a clean env file:
 *
 *   - an old `GROQ_API_KEY` in the env file is moved into `stt.json` beside it, once, mode 0600, with a
 *     deprecation notice; after a hand edit that empties the list the next boot does NOT move it again;
 *   - a settings directory that cannot be written (a read-only mount, the Docker case) is said at boot once, and
 *     a `/stt` change that cannot be kept names the file instead of pretending, the pasted key still deleted;
 *   - the END of a local-engine install that a reload (or a restart) interrupted: the remembered progress message is
 *     picked up where it stands — attached to a job that still runs, or settled when the job ended while the bot was
 *     down — and the engine joins the list, with the message turned into its outcome and its buttons.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { appendInstallProgress, holdInstallLock, releaseInstallLock, writeInstalledMarker } from './fixtures/sttInstallFiles';
import { getSttPaths } from '../stt/sttInstall';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
/** The old-style key in the env file: shaped like a Groq key, found nowhere in the bot's output. */
const legacyGroqKey = 'gsk_e2eLegacyEnvKey1234567890';
/** The key the operator pastes into the step that cannot be saved. */
const pastedGroqKey = 'gsk_e2ePastedKey1234567890abc';
const launchLine = 'Launching Telegraf bot (long polling';
const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const readOnlyDirectoryMode = 0o500;
const ownerOnlyFileMode = 0o600;

/** The permission checks below are ignored for root, where a read-only directory is still writable. */
const isRoot = process.getuid?.() === 0;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let apiRoot = '';
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

/** The instance's env file settings; `extra` adds what a step needs. */
async function buildEnvFileVariables(instance: IsolatedInstanceLayout, extra: Record<string, string>): Promise<Record<string, string>> {
  return {
    TELEGRAM_BOT_TOKEN: fakeBotToken,
    TELEGRAM_API_ROOT: apiRoot,
    ALLOWED_GROUP_ID: group.id.toString(),
    CHAT_MODE: 'group',
    DATA_DIR: instance.dataDir,
    WORK_ROOT: instance.workRoot,
    TMUX_TMPDIR: instance.tmuxTmpDir,
    CLAUDE_BIN: writeFakeClaudeLauncher(instance, null),
    // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
    OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
    SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
    ...extra,
  };
}

/** Start charness on `instance`'s env file and wait for its first poll to reach the fake Bot API. */
async function bootCharness(instance: IsolatedInstanceLayout): Promise<void> {
  charness = new IsolatedCharness(instance);
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

function getSttConfigFilePath(instance: IsolatedInstanceLayout): string {
  return path.join(path.dirname(instance.envFile), 'stt.json');
}

/** The slice of `stt.json` the install steps read and seed. */
interface SttFileSlice {
  engines: Array<{ id: string; kind: string; apiKey?: string }>;
}

function readSttFile(instance: IsolatedInstanceLayout): SttFileSlice {
  return JSON.parse(fs.readFileSync(getSttConfigFilePath(instance), 'utf8'));
}

/** The remembered install message in `state.json` (`undefined`: none). Written by the bot before it answers, so a read is current. */
function readRememberedInstallMessage(instance: IsolatedInstanceLayout): { threadKey: string; messageId: number; shouldEnableOnDone?: boolean } | undefined {
  return JSON.parse(fs.readFileSync(path.join(instance.dataDir, 'state.json'), 'utf8')).sttInstallProgress;
}

/**
 * The remembered install message is forgotten LAST, after the message itself was turned into its outcome: a read right
 * behind the edit can still see it. Wait for the exact state — gone — instead of reading once.
 */
async function waitUntilInstallMessageForgotten(instance: IsolatedInstanceLayout): Promise<void> {
  await getCharness().waitFor('the remembered install message to be forgotten', replyTimeoutMs, () => readRememberedInstallMessage(instance) === undefined);
}

/** What a bot that went down in the middle of an install `/stt` started leaves in `state.json`: the progress message. */
function seedRememberedInstallMessage(instance: IsolatedInstanceLayout, messageId: number, shouldEnableOnDone: boolean): void {
  const statePath = path.join(instance.dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.sttInstallProgress = { threadKey: `${group.id}:${topicThreadId}`, messageId, ...(shouldEnableOnDone ? { shouldEnableOnDone } : {}) };
  fs.writeFileSync(statePath, JSON.stringify(state));
}

/** A list with one hosted engine, so "the local engine joins FIRST" is visible. */
function seedOneHostedEngine(instance: IsolatedInstanceLayout): void {
  fs.writeFileSync(getSttConfigFilePath(instance), `${JSON.stringify({ engines: [{ id: 'q1', kind: 'groq', apiKey: legacyGroqKey }] }, null, 2)}\n`, { mode: ownerOnlyFileMode });
}

describe('Voice settings at boot, end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-stt-', ['proj'], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    topic = new TopicDriver(fakeTelegram, getCharness, topicThreadId, replyTimeoutMs);
    apiRoot = await fakeTelegram.start();
  });

  after(async () => {
    await charness?.stop();
    // The read-only step leaves a directory the cleanup could not empty.
    const readOnlyDirectory = layout ? path.join(layout.testRoot, 'readOnlyConfig') : null;
    if (readOnlyDirectory && fs.existsSync(readOnlyDirectory)) fs.chmodSync(readOnlyDirectory, 0o700);
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('an old GROQ_API_KEY in the env file moves into stt.json beside it at boot: private, announced once, shown by /stt, shown nowhere', async () => {
    const instance = getLayout();
    writeInstanceEnvFile(instance, await buildEnvFileVariables(instance, { GROQ_API_KEY: legacyGroqKey }));
    await bootCharness(instance);

    const sttConfigPath = getSttConfigFilePath(instance);
    const movedLine = `[STT] moved groq from the environment into ${sttConfigPath}`;
    assert.equal(getCharness().output.split(movedLine).length - 1, 1, 'the move is logged once');
    assert.ok(getCharness().output.includes('GROQ_API_KEY/OPENAI_API_KEY in .env is deprecated'), 'with the deprecation notice');
    const migrated = JSON.parse(fs.readFileSync(sttConfigPath, 'utf8')) as { engines: Array<{ kind: string; apiKey?: string }> };
    assert.deepEqual(migrated.engines.map((engine) => [engine.kind, engine.apiKey]), [['groq', legacyGroqKey]]);
    assert.equal(fs.statSync(sttConfigPath).mode & 0o777, ownerOnlyFileMode);

    const screen = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
    assert.ok(topic.getKeyboardLabels(screen).flat().some((label) => label.startsWith('1. Groq')), 'the migrated engine is listed');
    assert.ok(!screen.text.includes(legacyGroqKey), 'the key is not printed');
    assert.ok(!getCharness().output.includes(legacyGroqKey), 'nor logged');
  });

  it('after a hand edit that empties the list, the next boot does not move the env key in again', async () => {
    const instance = getLayout();
    const sttConfigPath = getSttConfigFilePath(instance);
    await getCharness().stop();
    fs.writeFileSync(sttConfigPath, `${JSON.stringify({ engines: [] }, null, 2)}\n`);

    await bootCharness(instance);
    assert.ok(!getCharness().output.includes('[STT] moved'), 'nothing is migrated: the file exists');
    assert.deepEqual((JSON.parse(fs.readFileSync(sttConfigPath, 'utf8')) as { engines: unknown[] }).engines, []);
    await topic.sendAndAwaitReply('/stt', 'No engines yet');
  });

  it('an install that was still running when the bot reloaded: the same message follows it and, when it ends, the engine joins the list FIRST', async () => {
    const instance = getLayout();
    const installMessage = await topic.sendAndAwaitReply('/stt', 'No engines yet');
    await getCharness().stop();
    seedRememberedInstallMessage(instance, installMessage.message_id, true);
    seedOneHostedEngine(instance);
    holdInstallLock(instance.dataDir);
    appendInstallProgress(instance.dataDir, { phase: 'downloadingModel', detail: '12/216 MB', bytesDownloaded: 12 * 1024 * 1024 });

    await bootCharness(instance);
    await topic.waitForMessageText('the progress follows the running job', installMessage, (text) => text.includes('Downloading the model 12/216 MB'));
    assert.deepEqual(readSttFile(instance).engines.map((engine) => engine.kind), ['groq'], 'nothing joins the list before the job ends');

    writeInstalledMarker(instance.dataDir);
    appendInstallProgress(instance.dataDir, { phase: 'done', detail: '', bytesDownloaded: 0 });
    releaseInstallLock(instance.dataDir);
    await topic.waitForMessageText('the message turns into the outcome', installMessage, (text) => text.includes('Local recognition is ready'));
    assert.ok(topic.getKeyboardData(installMessage).flat().some((data) => data.startsWith('stt_bk_')), 'with its Settings button');
    assert.deepEqual(readSttFile(instance).engines.map((engine) => engine.kind), ['gigaam', 'groq'], 'the process that saw the install end is not the one that started it, and it still enabled the engine');
    await waitUntilInstallMessageForgotten(instance);
  });

  it('an install that finished while the bot was down: the frozen message becomes "ready" at boot and the engine joins the list', async () => {
    const instance = getLayout();
    const frozenMessage = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
    await getCharness().stop();
    seedRememberedInstallMessage(instance, frozenMessage.message_id, true);
    seedOneHostedEngine(instance); // the engine was not listed yet when the bot went down
    fs.rmSync(getSttPaths(instance.dataDir).progressFile, { force: true });
    appendInstallProgress(instance.dataDir, { phase: 'done', detail: '', bytesDownloaded: 0 });
    writeInstalledMarker(instance.dataDir);

    await bootCharness(instance);
    await topic.waitForMessageText('the frozen message settled at boot', frozenMessage, (text) => text.includes('Local recognition is ready'));
    assert.ok(topic.getKeyboardData(frozenMessage).flat().some((data) => data.startsWith('stt_bk_')), 'with its Settings button');
    assert.deepEqual(readSttFile(instance).engines.map((engine) => engine.kind), ['gigaam', 'groq']);
    await waitUntilInstallMessageForgotten(instance);
  });

  it('an install job that died while the bot was down: the message says it ended without a result, with Retry, and the list is untouched', async () => {
    const instance = getLayout();
    const lostMessage = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
    await getCharness().stop();
    seedRememberedInstallMessage(instance, lostMessage.message_id, true);
    seedOneHostedEngine(instance);
    fs.rmSync(getSttPaths(instance.dataDir).progressFile, { force: true });
    fs.rmSync(getSttPaths(instance.dataDir).markerFile, { force: true });

    await bootCharness(instance);
    await topic.waitForMessageText('the message reports the lost job', lostMessage, (text) => text.includes('the install job ended without a result'));
    assert.ok(topic.getKeyboardData(lostMessage).flat().some((data) => data.startsWith('stt_er_')), 'Retry is offered');
    assert.deepEqual(readSttFile(instance).engines.map((engine) => engine.kind), ['groq']);
    await waitUntilInstallMessageForgotten(instance);
  });

  it('a settings directory that cannot be written is said at boot once, and /stt names the file when a pasted key cannot be kept', { skip: isRoot }, async () => {
    const instance = getLayout();
    await getCharness().stop();
    const readOnlyDirectory = path.join(instance.testRoot, 'readOnlyConfig');
    fs.mkdirSync(readOnlyDirectory);
    const readOnlyInstance: IsolatedInstanceLayout = { ...instance, envFile: path.join(readOnlyDirectory, 'instance.env') };
    writeInstanceEnvFile(readOnlyInstance, await buildEnvFileVariables(readOnlyInstance, {}));
    fs.chmodSync(readOnlyDirectory, readOnlyDirectoryMode);

    await bootCharness(readOnlyInstance);
    const sttConfigPath = getSttConfigFilePath(readOnlyInstance);
    const bootLine = `[STT] ${sttConfigPath} cannot be written (EACCES)`;
    assert.equal(getCharness().output.split(bootLine).length - 1, 1, 'the boot log says it once');

    const screen = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
    assert.ok(screen.text.includes(sttConfigPath), 'the screen names where the settings would live');
    const addData = topic.getKeyboardData(screen).flat().find((data) => data.startsWith('stt_ad_'));
    assert.ok(addData);
    await topic.tapAndAwaitAnswer(screen, addData);
    await topic.waitForMessageText('the add menu', screen, (text) => text.includes('Which engine do you want to add?'));
    const groqData = topic.getKeyboardData(screen).flat().find((data) => data.startsWith('stt_an_gq_'));
    assert.ok(groqData);
    await topic.tapAndAwaitAnswer(screen, groqData);
    await topic.waitForMessageText('the key prompt', screen, (text) => text.includes('Paste the API key now'));

    const keyMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, pastedGroqKey);
    await topic.waitForMessageText('the save failure', screen, (text) => text.includes(`Could not write the settings file ${sttConfigPath}`));
    assert.equal(fakeTelegram.getMessage(keyMessageId)?.isDeleted, true, 'the pasted key is deleted even though it could not be kept');
    assert.equal(fs.existsSync(sttConfigPath), false, 'nothing was written anywhere');
    assert.ok(!JSON.stringify(topic.listMessages().map((message) => message.text)).includes(pastedGroqKey), 'the key is not repeated');
    assert.ok(!getCharness().output.includes(pastedGroqKey), 'nor logged');
  });
});
