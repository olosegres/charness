/**
 * @description A voice note on a BUSY machine, at process level: the BUILT charness started the way an isolated instance
 * is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the local engine's
 * interpreter replaced by a wrapper that runs the fake sidecar (`fixtures/fakeSttSidecar.cjs`) with a model load of 17 s —
 * past the 15 s the bot once gave up at, when each voice killed the loading process and the next one began from zero:
 *
 *   - the first voice note starts the engine and is recognised after the load, instead of failing with «not ready in 15 s»;
 *   - a voice note of ANOTHER topic that arrives while the engine is still loading waits for the same start: one process,
 *     both notes recognised, the slow load said once in the bot's log.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the "engine" is a fake. Everything the test starts is stopped
 * in `after` (the plain bot stops its sidecar in its graceful shutdown; the fake also follows its owner).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { writeInstalledMarker } from './fixtures/sttInstallFiles';
import { getSttPaths } from '../stt/sttInstall';
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

const group = { id: -1001111111111, title: 'ExampleGroup' };
const firstTopicThreadId = 111;
const secondTopicThreadId = 222;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const launchLine = 'Launching Telegraf bot (long polling';
const bootTimeoutMs = 60 * 1000;
/** The model load of the fake engine: longer than the 15 s the bot once waited. */
const slowLoadMs = 17 * 1000;
/** The load plus a busy machine's slack for the download, the poll and the paced echo. */
const recognisedTimeoutMs = slowLoadMs + 45 * 1000;
const claimTimeoutMs = 30 * 1000;
const fakeTranscript = 'fake transcript';
const voiceDurationSeconds = 3;
const voiceFileBytes = 2048;
const executableMode = 0o755;
const ownerOnlyFileMode = 0o600;
const fakeSidecarPath = path.join(__dirname, 'fixtures', 'fakeSttSidecar.cjs');
const startedLinePattern = /\[STT\] sidecar started pid \d+ port \d+ in \d+ms/g;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let firstTopic: TopicDriver;
let secondTopic: TopicDriver;
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

async function buildEnvFileVariables(instance: IsolatedInstanceLayout): Promise<Record<string, string>> {
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
    OPENCODE_URL: `http://127.0.0.1:${await getUnservedPort()}`,
    SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
    ...getTelegramFlowTestTimingsEnv(),
  };
}

/**
 * The local engine as installed, with a FAKE interpreter: the bot runs `<venv>/bin/python -I <sidecar script> <args>`, and
 * this wrapper drops the first two words and runs the fake sidecar with a model load of {@link slowLoadMs} instead.
 */
function seedSlowLocalEngine(instance: IsolatedInstanceLayout): void {
  writeInstalledMarker(instance.dataDir);
  const paths = getSttPaths(instance.dataDir);
  const wrapper = `#!/bin/sh\nshift 2\nexec "${process.execPath}" "${fakeSidecarPath}" --ready-delay-ms ${slowLoadMs} "$@"\n`;
  fs.writeFileSync(paths.venvPython, wrapper, { mode: executableMode });
  const sttConfig = { engines: [{ id: 'g', kind: 'gigaam' }], gigaam: { idleMinutes: 5, workers: 1 } };
  fs.writeFileSync(path.join(path.dirname(instance.envFile), 'stt.json'), `${JSON.stringify(sttConfig, null, 2)}\n`, { mode: ownerOnlyFileMode });
}

function readRecordedPort(instance: IsolatedInstanceLayout): number | null {
  try {
    const record: { port: number } = JSON.parse(fs.readFileSync(path.join(getSttPaths(instance.dataDir).root, 'sidecar.json'), 'utf8'));
    return record.port;
  } catch {
    return null;
  }
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

describe('A voice note while the local engine loads slowly, end to end: built charness, fake Bot API, fake engine', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-stt-slow-', ['proj'], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    firstTopic = new TopicDriver(fakeTelegram, getCharness, firstTopicThreadId, recognisedTimeoutMs);
    secondTopic = new TopicDriver(fakeTelegram, getCharness, secondTopicThreadId, recognisedTimeoutMs);
    apiRoot = await fakeTelegram.start();

    const instance = getLayout();
    seedSlowLocalEngine(instance);
    writeInstanceEnvFile(instance, await buildEnvFileVariables(instance));
    charness = new IsolatedCharness(instance);
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
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

  it('a voice note is recognised after a 17 s load, and one from another topic that arrives meanwhile shares the same start', async () => {
    const instance = getLayout();
    const firstFileId = 'voice-slow-1';
    const secondFileId = 'voice-slow-2';
    fakeTelegram.registerFile(firstFileId, Buffer.alloc(voiceFileBytes, 7));
    fakeTelegram.registerFile(secondFileId, Buffer.alloc(voiceFileBytes, 8));

    const firstVoiceId = fakeTelegram.pushOperatorVoice(firstTopicThreadId, firstFileId, voiceDurationSeconds);
    // The engine is loading its model (its record is claimed, no port yet) while the note waits for it.
    await getCharness().waitFor('the engine to claim its record and start loading', claimTimeoutMs, () => readRecordedPort(instance) === 0);

    const secondVoiceId = fakeTelegram.pushOperatorVoice(secondTopicThreadId, secondFileId, voiceDurationSeconds);
    await firstTopic.waitForMessage('the first voice note\'s echo', (message) => message.message_id > firstVoiceId && message.text === `🎤 ${fakeTranscript}`);
    await secondTopic.waitForMessage('the second voice note\'s echo', (message) => message.message_id > secondVoiceId && message.text === `🎤 ${fakeTranscript}`);

    const output = getCharness().output;
    assert.equal(countMatches(output, startedLinePattern), 1, 'ONE engine process served both notes');
    assert.equal(countMatches(output, /\[transcribe\] ok via gigaam/g), 2, 'both notes were recognised by the local engine');
    assert.ok(!output.includes('[transcribe] failed'), 'no voice failed');
    assert.ok(!fakeTelegram.listBotMessages(firstTopicThreadId).some((message) => message.text.includes('Failed to transcribe')), 'and the user was told nothing failed');
    assert.ok(output.includes('is still loading its model after 15 s; waiting for it (up to 120 s)'), 'the slow load is in the log, once');
    assert.equal(countMatches(output, /is still loading its model after/g), 1);
  });
});
