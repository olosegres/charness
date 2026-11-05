/**
 * @description The «🎙 Transcribing the voice message…» note, at process level: the BUILT charness started the way an isolated
 * instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the local engine's
 * interpreter replaced by a wrapper that runs the fake sidecar (`fixtures/fakeSttSidecar.cjs`) with a model load of 8 s — well
 * past the 3 s the note waits for. Each step is a voice note in a topic of its own:
 *
 *   - the engine DIES while loading: the note shows after the delay, is deleted when the voice fails, the failure notice stays;
 *   - a graceful STOP of the bot while the note is up (a hot reload): the shutdown sweep deletes it;
 *   - a KILL of the bot while the note is up: the note is saved with the transient messages, stays while the bot is down and is
 *     deleted by the next boot;
 *   - a delete that Telegram REFUSES: the note stays in the saved set and the next sweep deletes it;
 *   - a slow load that SUCCEEDS: the note is silent, shows only after the delay, and is gone once the 🎤 echo is there (and
 *     out of the saved set);
 *   - a WARM engine answers within the delay: no note is ever sent, not even later.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the "engine" is a fake. Everything the test starts is stopped
 * in `after` (the plain bot stops its sidecar in its graceful shutdown; the fake also follows its owner).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { writeInstalledMarker } from './fixtures/sttInstallFiles';
import { getStatePath, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getSttPaths } from '../stt/sttInstall';
import { voiceProgressNoteDelayMs } from '../voiceProgressNote';
import { enDict } from '../i18n/en';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
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
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const dyingTopicThreadId = 111;
const stoppedTopicThreadId = 222;
const killedTopicThreadId = 333;
const refusedTopicThreadId = 444;
const slowTopicThreadId = 555;
const warmTopicThreadId = 666;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
/** The model load of the fake engine: long enough that the note (3 s) is up for seconds before the text. */
const slowLoadMs = 8 * 1000;
/** Where the fake engine that is told to die gives up: after the note's delay, before the load would have ended. */
const dieWhileLoadingMs = 6 * 1000;
/** The load plus a busy machine's slack for the download, the poll and the echo. */
const recognisedTimeoutMs = slowLoadMs + 45 * 1000;
/** A node timer may fire a millisecond early; this is the room the lower bounds of the delay leave for that. */
const timerToleranceMs = 50;
/** How long after the echo a warm voice is watched for a note that should never come. */
const lateNoteWatchMs = voiceProgressNoteDelayMs + 1000;
const fakeTranscript = 'fake transcript';
const voiceDurationSeconds = 3;
const voiceFileBytes = 2048;
const executableMode = 0o755;
const ownerOnlyFileMode = 0o600;
const fakeSidecarPath = path.join(__dirname, 'fixtures', 'fakeSttSidecar.cjs');
/** While this file exists the next engine start dies while loading (the wrapper consumes it). */
const dieOnceMarkerName = 'fake-engine-dies-while-loading';
const noteText = enDict['voice.transcribing'];
const echoText = `🎤 ${fakeTranscript}`;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let apiRoot = '';
let defaultTmuxSessionsBefore: string[] = [];
let sentVoiceCount = 0;

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

function createTopic(threadId: number): TopicDriver {
  return new TopicDriver(fakeTelegram, getCharness, threadId, recognisedTimeoutMs);
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
    OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
    SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
    ...getTelegramFlowTestTimingsEnv(),
  };
}

function getDieOnceMarkerPath(instance: IsolatedInstanceLayout): string {
  return path.join(instance.dataDir, dieOnceMarkerName);
}

/**
 * The local engine as installed, with a FAKE interpreter: the bot runs `<venv>/bin/python -I <sidecar script> <args>`, and this
 * wrapper drops the first two words and runs the fake sidecar with a model load of {@link slowLoadMs} instead — or, once, with a
 * load that fails after {@link dieWhileLoadingMs} when the marker file is there.
 */
function seedSlowLocalEngine(instance: IsolatedInstanceLayout): void {
  writeInstalledMarker(instance.dataDir);
  const paths = getSttPaths(instance.dataDir);
  const markerPath = getDieOnceMarkerPath(instance);
  const wrapper = [
    '#!/bin/sh',
    'shift 2',
    `if [ -f "${markerPath}" ]; then rm -f "${markerPath}"; set -- --die-while-loading-ms ${dieWhileLoadingMs} "$@"; fi`,
    `exec "${process.execPath}" "${fakeSidecarPath}" --ready-delay-ms ${slowLoadMs} "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(paths.venvPython, wrapper, { mode: executableMode });
  const sttConfig = { engines: [{ id: 'g', kind: 'gigaam' }], gigaam: { idleMinutes: 5, workers: 1 } };
  fs.writeFileSync(path.join(path.dirname(instance.envFile), 'stt.json'), `${JSON.stringify(sttConfig, null, 2)}\n`, { mode: ownerOnlyFileMode });
}

interface SentVoice {
  messageId: number;
  pushedAtMs: number;
}

/** The operator sends a voice note (a file of its own) in topic `threadId`. */
function sendVoice(threadId: number): SentVoice {
  sentVoiceCount += 1;
  const fileId = `voice-note-${sentVoiceCount}`;
  fakeTelegram.registerFile(fileId, Buffer.alloc(voiceFileBytes, sentVoiceCount));
  const pushedAtMs = Date.now();
  return { messageId: fakeTelegram.pushOperatorVoice(threadId, fileId, voiceDurationSeconds), pushedAtMs };
}

function checkIsNoteAfter(voice: SentVoice): (message: FakeTelegramMessage) => boolean {
  return (message) => message.message_id > voice.messageId && message.text === noteText;
}

/** How many «transcribing» notes the bot has SENT into a topic, deleted or not. */
function countNoteSends(threadId: number): number {
  return fakeTelegram.listCalls('sendMessage').filter((call) => Number(call.payload.message_thread_id) === threadId && call.payload.text === noteText).length;
}

/** Waits for the note of `voice` and checks what its first sight must show: silent, and not before the delay. */
async function waitForNote(topic: TopicDriver, voice: SentVoice): Promise<FakeTelegramMessage> {
  const note = await topic.waitForMessage('the transcribing note', checkIsNoteAfter(voice));
  assert.equal(note.isSilent, true, 'the note is sent silently');
  assert.ok(Date.now() - voice.pushedAtMs >= voiceProgressNoteDelayMs - timerToleranceMs, 'the note came after the delay, not at once');
  return note;
}

async function waitForNoteDeleted(note: FakeTelegramMessage): Promise<void> {
  await getCharness().waitFor('the transcribing note to be deleted', recognisedTimeoutMs, () => note.isDeleted === true);
}

/** The transient message ids `state.json` holds for a topic (the set a restart cleans up). */
function readSavedTransientIds(threadId: number): number[] {
  const saved: { transientFrames?: Record<string, number[]> } = JSON.parse(fs.readFileSync(getStatePath(getLayout()), 'utf8'));
  return saved.transientFrames?.[keyToString(makeTelegramKey(group.id, threadId))] ?? [];
}

describe('The transcribing note of a voice message, end to end: built charness, fake Bot API, fake engine', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-voice-note-', ['proj'], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    apiRoot = await fakeTelegram.start();

    const instance = getLayout();
    seedSlowLocalEngine(instance);
    writeInstanceEnvFile(instance, await buildEnvFileVariables(instance));
    charness = await startCharnessOnInstance(instance, fakeTelegram);
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

  it('an engine that dies while it loads: the note shows after the delay and is deleted when the voice fails, the failure notice stays', async () => {
    fs.writeFileSync(getDieOnceMarkerPath(getLayout()), 'die once');
    const topic = createTopic(dyingTopicThreadId);
    const voice = sendVoice(dyingTopicThreadId);

    const note = await waitForNote(topic, voice);
    const failure = await topic.waitForMessage('the failure notice', (message) => message.message_id > voice.messageId && message.text.startsWith(enDict['voice.failed']));
    await waitForNoteDeleted(note);

    assert.ok(failure.text.includes('exited before it was ready'), `the failure names its cause: "${failure.text}"`);
    assert.ok(topic.listMessages().some((message) => message.message_id === failure.message_id), 'the failure notice is still on screen');
    assert.ok(!topic.listMessages().some((message) => message.text === noteText), 'no note is left');
    assert.equal(countNoteSends(dyingTopicThreadId), 1, 'one voice, one note');
  });

  it('a graceful stop of the bot while the note is up (a hot reload) deletes it', async () => {
    const topic = createTopic(stoppedTopicThreadId);
    const voice = sendVoice(stoppedTopicThreadId);
    const note = await waitForNote(topic, voice);

    await getCharness().stop();

    // The stop returns when the process is gone: the shutdown sweep has run by then or never will.
    assert.equal(note.isDeleted, true, 'the shutdown sweep deleted the note');
  });

  it('a kill of the bot while the note is up leaves it on screen, saved with the transient messages; the next boot deletes it', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    const topic = createTopic(killedTopicThreadId);
    const voice = sendVoice(killedTopicThreadId);
    const note = await waitForNote(topic, voice);
    await getCharness().waitFor('the note to be saved with the transient messages', recognisedTimeoutMs, () => readSavedTransientIds(killedTopicThreadId).includes(note.message_id));

    getCharness().killSync();
    assert.notEqual(note.isDeleted, true, 'precondition: a killed bot cleans nothing up, the note is still on screen');

    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await waitForNoteDeleted(note);
    await getCharness().waitFor('the saved set to be emptied', recognisedTimeoutMs, () => readSavedTransientIds(killedTopicThreadId).length === 0);
  });

  it('a delete that Telegram refuses leaves the note in the saved set, and the next sweep deletes it', async () => {
    const topic = createTopic(refusedTopicThreadId);
    const voice = sendVoice(refusedTopicThreadId);
    const note = await waitForNote(topic, voice);

    // Refused while the engine is still loading: the delete the text triggers is the one that fails.
    fakeTelegram.isMessageDeletionRefused = true;
    try {
      await topic.waitForMessage('the voice note\'s echo', (message) => message.message_id > voice.messageId && message.text === echoText);
      await getCharness().waitFor('the bot to try the delete', recognisedTimeoutMs, () => fakeTelegram.listCalls('deleteMessage').some((call) => Number(call.payload.message_id) === note.message_id));
      assert.notEqual(note.isDeleted, true, 'precondition: the refused delete left the note on screen');
      assert.ok(readSavedTransientIds(refusedTopicThreadId).includes(note.message_id), 'a note that stayed keeps its place in the saved set');
    } finally {
      fakeTelegram.isMessageDeletionRefused = false;
    }

    await getCharness().stop();
    assert.equal(note.isDeleted, true, 'the shutdown sweep retried it');
  });

  it('a slow load that succeeds: the note is silent and comes only after the delay, and it is gone once the 🎤 echo is there', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    const topic = createTopic(slowTopicThreadId);
    const voice = sendVoice(slowTopicThreadId);

    const note = await waitForNote(topic, voice);
    assert.ok(!topic.listMessages().some((message) => message.text === echoText), 'precondition: the text is not here yet while the note shows');
    const echo = await topic.waitForMessage('the voice note\'s echo', (message) => message.message_id > voice.messageId && message.text === echoText);
    await waitForNoteDeleted(note);
    await getCharness().waitFor('the deleted note to leave the saved set', recognisedTimeoutMs, () => readSavedTransientIds(slowTopicThreadId).length === 0);

    assert.ok(note.message_id < echo.message_id, 'the note was there before the text');
    assert.ok(!topic.listMessages().some((message) => message.text === noteText), 'no note is left next to the echo');
    assert.equal(countNoteSends(slowTopicThreadId), 1, 'one voice, one note');
    assert.ok(!getCharness().output.includes('[transcribe] failed'), 'the voice was recognised');
  });

  it('a warm engine answers within the delay: no note is ever sent for that voice, not even later', async () => {
    const topic = createTopic(warmTopicThreadId);
    const voice = sendVoice(warmTopicThreadId);

    await topic.waitForMessage('the voice note\'s echo', (message) => message.message_id > voice.messageId && message.text === echoText);
    const answeredAfterMs = Date.now() - voice.pushedAtMs;
    assert.ok(answeredAfterMs < voiceProgressNoteDelayMs, `precondition not met: the warm engine took ${answeredAfterMs} ms, not under the ${voiceProgressNoteDelayMs} ms delay — this box is too busy for the check`);

    // The note's timer must be cancelled by the text: a note that came 3 s after the voice would be a stray one.
    await new Promise((resolve) => setTimeout(resolve, lateNoteWatchMs));

    assert.equal(countNoteSends(warmTopicThreadId), 0, 'no note was sent');
  });
});
