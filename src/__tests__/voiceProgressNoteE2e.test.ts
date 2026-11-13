/**
 * @description The «🎙 Transcribing the voice message…» note, at process level: the BUILT charness started the way an isolated
 * instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the local engine's
 * interpreter replaced by a wrapper that runs the fake sidecar (`fixtures/fakeSttSidecar.cjs`).
 *
 * The slow moments are CONTROLLED, not timed: the fake engine loads its model, dies, or answers a recognition request only
 * when the test opens a gate file, so a note stays up for as long as the test wants and a slow test process can never miss it;
 * the fake Bot API holds a response for a duration it counts itself (`holdNextResponse`) and stamps every stored message and
 * every call with the time it happened (`createdAtMs`, `deletedAtMs`, `receivedAtMs`), and the order of events is checked on
 * those stamps — never on when the test noticed something. The exact 3 s threshold and the cleanup bound are the fake-timer
 * unit tests' (`voiceProgressNote.test.ts`); here the stamps only show the note did not come EARLY.
 *
 * Each step is a voice note in a topic of its own:
 *   - the engine DIES while loading (first: it needs a cold engine): the note goes, the failure notice stays;
 *   - the engine LOADS slowly and then answers: the note is silent, shows only after the delay, is gone with the 🎤 echo;
 *   - a WARM engine answers at once: no note is ever sent, not even later;
 *   - the delete of the note is HELD a moment: the echo waits for it — the note is gone before the transcript goes out;
 *   - the delete is held for good: the echo does not wait longer than the bound, and nothing is left behind;
 *   - the SEND of the note is held (it lands after the text): the echo is not held up, and the late note is deleted;
 *   - a graceful STOP of the bot while the note is up, and while its send is still in flight: the shutdown deletes it;
 *   - a KILL of the bot while the note is up: it stays, saved with the transient messages, and the next boot deletes it;
 *   - deletes that fail for a bad moment, at the shutdown and at the next boot: the id is kept and the next sweep deletes it.
 *
 * Nothing leaves the machine: the Bot API is on loopback and the "engine" is a fake. Everything the test starts is stopped
 * in `after` (the plain bot stops its sidecar in its graceful shutdown; the fake also follows its owner).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { writeInstalledMarker } from './fixtures/sttInstallFiles';
import { getStatePath, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { getSttPaths } from '../stt/sttInstall';
import { voiceProgressNoteCleanupBudgetMs, voiceProgressNoteDelayMs } from '../voiceProgressNote';
import { enDict } from '../i18n/en';
import { keyToString } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
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
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
/** One topic per step, so a step reads only its own messages. */
const topicThreadIds = {
  dyingEngine: 101,
  coldLoad: 102,
  warm: 103,
  heldDelete: 104,
  stalledDelete: 105,
  heldSend: 106,
  gracefulStop: 107,
  stopDuringSend: 108,
  kill: 109,
  retryChain: 110,
} as const;
/** How long any single wait of the flow may take: the gates, not the clock, decide when things happen. */
const waitTimeoutMs = 60 * 1000;
/** A node timer may fire a millisecond early; the room the lower bounds on stamps leave for it. */
const timerToleranceMs = 50;
/** How long the fake holds the response to the delete of a note in the «ordered» step: well inside the cleanup bound. */
const heldDeleteMs = 400;
/** How long after the echo a warm voice is watched for a note that should never come: the delay of the note, and a second more. */
const lateNoteWatchMs = voiceProgressNoteDelayMs + 1000;
const fakeTranscript = 'fake transcript';
const voiceDurationSeconds = 3;
const voiceFileBytes = 2048;
const executableMode = 0o755;
const ownerOnlyFileMode = 0o600;
const fakeSidecarPath = path.join(__dirname, 'fixtures', 'fakeSttSidecar.cjs');
const noteText = enDict['voice.transcribing'];
const echoText = `🎤 ${fakeTranscript}`;
/** What a Bot API answer for a moment Telegram is having trouble looks like: a failure a later try can fix. */
const serverErrorCode = 500;
const shutdownLogLine = 'SIGTERM received, shutting down';

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
  return new TopicDriver(fakeTelegram, getCharness, threadId, waitTimeoutMs);
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

/** The three gates of the fake engine: files the test creates (opens) and removes (closes). */
interface EngineGates {
  /** The model load ends only once this exists. */
  ready: string;
  /** While the load goes, the engine exits 1 once this exists. */
  die: string;
  /** A recognition request is answered only once this exists. */
  transcribe: string;
}

function getEngineGates(instance: IsolatedInstanceLayout): EngineGates {
  const gatesDir = path.join(instance.dataDir, 'fake-engine-gates');
  return { ready: path.join(gatesDir, 'ready'), die: path.join(gatesDir, 'die'), transcribe: path.join(gatesDir, 'transcribe') };
}

function openGate(gatePath: string): void {
  fs.mkdirSync(path.dirname(gatePath), { recursive: true });
  fs.writeFileSync(gatePath, 'open');
}

function closeGate(gatePath: string): void {
  fs.rmSync(gatePath, { force: true });
}

/** The gates as every step starts: the engine loads and recognises at once, and does not die. */
function resetEngineGates(): void {
  const gates = getEngineGates(getLayout());
  openGate(gates.ready);
  openGate(gates.transcribe);
  closeGate(gates.die);
}

/**
 * The local engine as installed, with a FAKE interpreter: the bot runs `<venv>/bin/python -I <sidecar script> <args>`, and this
 * wrapper drops the first two words and runs the fake sidecar with the three gates. The engine's request budget is long: a
 * recognition the test holds must not time out behind the test's back.
 */
function seedGatedLocalEngine(instance: IsolatedInstanceLayout): void {
  writeInstalledMarker(instance.dataDir);
  const paths = getSttPaths(instance.dataDir);
  const gates = getEngineGates(instance);
  const wrapper = [
    '#!/bin/sh',
    'shift 2',
    `exec "${process.execPath}" "${fakeSidecarPath}" --ready-after-file "${gates.ready}" --die-after-file "${gates.die}" --transcribe-after-file "${gates.transcribe}" "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(paths.venvPython, wrapper, { mode: executableMode });
  const sttConfig = { engines: [{ id: 'g', kind: 'gigaam', timeout: { baseSeconds: 300, percentOfDuration: 25 } }], gigaam: { idleMinutes: 5, workers: 1 } };
  fs.writeFileSync(path.join(path.dirname(instance.envFile), 'stt.json'), `${JSON.stringify(sttConfig, null, 2)}\n`, { mode: ownerOnlyFileMode });
}

interface SentVoice {
  messageId: number;
  /** When the fake stored the voice (the test process's clock): the moment it reached the bot's side. */
  createdAtMs: number;
}

/** The operator sends a voice note (a file of its own) in topic `threadId`. */
function sendVoice(threadId: number): SentVoice {
  sentVoiceCount += 1;
  const fileId = `voice-note-${sentVoiceCount}`;
  fakeTelegram.registerFile(fileId, Buffer.alloc(voiceFileBytes, sentVoiceCount));
  const messageId = fakeTelegram.pushOperatorVoice(threadId, fileId, voiceDurationSeconds);
  const stored = fakeTelegram.getMessage(messageId);
  if (!stored) throw new Error(`the fake lost the voice message ${messageId}`);
  return { messageId, createdAtMs: stored.createdAtMs };
}

function checkIsNoteAfter(voice: SentVoice): (message: FakeTelegramMessage) => boolean {
  return (message) => message.message_id > voice.messageId && message.text === noteText;
}

function checkIsEchoAfter(voice: SentVoice): (message: FakeTelegramMessage) => boolean {
  return (message) => message.message_id > voice.messageId && message.text === echoText;
}

function checkIsNoteSend(threadId: number): (payload: Record<string, unknown>) => boolean {
  return (payload) => Number(payload.message_thread_id) === threadId && payload.text === noteText;
}

function checkIsDeleteOf(message: FakeTelegramMessage): (payload: Record<string, unknown>) => boolean {
  return (payload) => Number(payload.message_id) === message.message_id;
}

/** How many «transcribing» notes the bot has SENT into a topic, deleted or not. */
function countNoteSends(threadId: number): number {
  return fakeTelegram.listCalls('sendMessage').filter((call) => checkIsNoteSend(threadId)(call.payload)).length;
}

/** The bot's delete calls for a message, in order. */
function listDeleteCalls(message: FakeTelegramMessage): Array<{ receivedAtMs: number }> {
  return fakeTelegram.listCalls('deleteMessage').filter((call) => checkIsDeleteOf(message)(call.payload));
}

/**
 * Waits for the note of `voice` and checks what its first sight must show: silent, and not sent before the delay — on the stamps
 * the fake took when the voice and the note reached it, not on when the test looked. The engine is gated, so the note stays
 * up for as long as the step needs.
 */
async function waitForNote(topic: TopicDriver, voice: SentVoice): Promise<FakeTelegramMessage> {
  const note = await topic.waitForMessage('the transcribing note', checkIsNoteAfter(voice));
  assert.equal(note.isSilent, true, 'the note is sent silently');
  assert.ok(note.createdAtMs - voice.createdAtMs >= voiceProgressNoteDelayMs - timerToleranceMs, `the note was sent ${note.createdAtMs - voice.createdAtMs} ms after the voice, not after the ${voiceProgressNoteDelayMs} ms delay`);
  return note;
}

async function waitForNoteDeleted(note: FakeTelegramMessage): Promise<void> {
  await getCharness().waitFor('the transcribing note to be deleted', waitTimeoutMs, () => note.isDeleted === true);
}

/** The transient message ids `state.json` holds for a topic (the set a restart cleans up). */
function readSavedTransientIds(threadId: number): number[] {
  const statePath = getStatePath(getLayout());
  if (!fs.existsSync(statePath)) return [];
  const saved: { transientFrames?: Record<string, number[]> } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return saved.transientFrames?.[keyToString(makeTelegramKey(group.id, threadId))] ?? [];
}

async function startCharness(): Promise<void> {
  charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('The transcribing note of a voice message, end to end: built charness, fake Bot API, gated fake engine', () => {
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
    seedGatedLocalEngine(instance);
    resetEngineGates();
    writeInstanceEnvFile(instance, await buildEnvFileVariables(instance));
    await startCharness();
  });

  beforeEach(() => resetEngineGates());

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
    const gates = getEngineGates(getLayout());
    closeGate(gates.ready);
    const topic = createTopic(topicThreadIds.dyingEngine);
    const voice = sendVoice(topicThreadIds.dyingEngine);

    const note = await waitForNote(topic, voice);
    openGate(gates.die);
    const failure = await topic.waitForMessage('the failure notice', (message) => message.message_id > voice.messageId && message.text.startsWith(enDict['voice.failed']));
    await waitForNoteDeleted(note);

    assert.ok(failure.text.includes('exited before it was ready'), `the failure names its cause: "${failure.text}"`);
    assert.ok(topic.listMessages().some((message) => message.message_id === failure.message_id), 'the failure notice is still on screen');
    assert.ok(!topic.listMessages().some((message) => message.text === noteText), 'no note is left');
    assert.equal(countNoteSends(topicThreadIds.dyingEngine), 1, 'one voice, one note');
  });

  it('a slow load that succeeds: the note is silent and comes only after the delay, and it is gone once the 🎤 echo is there', async () => {
    closeGate(getEngineGates(getLayout()).ready);
    const topic = createTopic(topicThreadIds.coldLoad);
    const voice = sendVoice(topicThreadIds.coldLoad);

    const note = await waitForNote(topic, voice);
    assert.ok(!topic.listMessages().some((message) => message.text === echoText), 'precondition: the text is not here while the engine loads');
    openGate(getEngineGates(getLayout()).ready);
    const echo = await topic.waitForMessage('the voice note\'s echo', checkIsEchoAfter(voice));
    await waitForNoteDeleted(note);
    await getCharness().waitFor('the deleted note to leave the saved set', waitTimeoutMs, () => readSavedTransientIds(topicThreadIds.coldLoad).length === 0);

    assert.ok(note.message_id < echo.message_id, 'the note was there before the text');
    assert.ok(!topic.listMessages().some((message) => message.text === noteText), 'no note is left next to the echo');
    assert.equal(countNoteSends(topicThreadIds.coldLoad), 1, 'one voice, one note');
  });

  it('a warm engine answers at once: no note is ever sent for that voice, not even later', async () => {
    // The step before left the engine loaded (it stays for the idle minutes): this voice meets a warm one.
    const topic = createTopic(topicThreadIds.warm);
    const voice = sendVoice(topicThreadIds.warm);
    const echo = await topic.waitForMessage('the voice note\'s echo', checkIsEchoAfter(voice));
    const answeredAfterMs = echo.createdAtMs - voice.createdAtMs;
    assert.ok(answeredAfterMs < voiceProgressNoteDelayMs, `precondition not met: the bot answered after ${answeredAfterMs} ms (stamped by the fake), not within the ${voiceProgressNoteDelayMs} ms delay — nothing can be proven about the note on a box this busy`);

    // The note's timer must be cancelled by the text: a note that came a delay after the voice would be a stray one.
    await new Promise((resolve) => setTimeout(resolve, lateNoteWatchMs));

    assert.equal(countNoteSends(topicThreadIds.warm), 0, 'no note was sent');
  });

  it('the note is gone BEFORE the transcript goes out: a delete the fake holds for a moment holds the echo for that moment', async () => {
    closeGate(getEngineGates(getLayout()).transcribe);
    const topic = createTopic(topicThreadIds.heldDelete);
    const voice = sendVoice(topicThreadIds.heldDelete);
    const note = await waitForNote(topic, voice);
    fakeTelegram.holdNextResponse('deleteMessage', heldDeleteMs, checkIsDeleteOf(note));

    openGate(getEngineGates(getLayout()).transcribe);
    const echo = await topic.waitForMessage('the voice note\'s echo', checkIsEchoAfter(voice));
    await waitForNoteDeleted(note);

    const [deleteCall] = listDeleteCalls(note);
    assert.ok(deleteCall, 'the bot deleted the note');
    assert.ok(echo.createdAtMs >= deleteCall.receivedAtMs + heldDeleteMs - timerToleranceMs, `the echo was stored ${echo.createdAtMs - deleteCall.receivedAtMs} ms after the delete reached the fake, which answered after ${heldDeleteMs} ms: the transcript went out before the note was gone`);
    assert.ok(voiceProgressNoteCleanupBudgetMs > heldDeleteMs, 'the hold stays inside the bound, so waiting for the delete is what the product must do here');
  });

  it('a delete that never answers does not hold the transcript back for longer than the bound, and nothing is left behind', async () => {
    closeGate(getEngineGates(getLayout()).transcribe);
    const topic = createTopic(topicThreadIds.stalledDelete);
    const voice = sendVoice(topicThreadIds.stalledDelete);
    const note = await waitForNote(topic, voice);
    const stalledDelete = createDeferred();
    fakeTelegram.holdNextResponse('deleteMessage', stalledDelete.promise, checkIsDeleteOf(note));

    openGate(getEngineGates(getLayout()).transcribe);
    // The delete is released only after the echo was seen: a bot that waited for it without a bound would never send the echo.
    const echo = await topic.waitForMessage('the voice note\'s echo, with the delete still unanswered', checkIsEchoAfter(voice));
    stalledDelete.resolve();
    await waitForNoteDeleted(note);

    const [deleteCall] = listDeleteCalls(note);
    assert.ok(deleteCall, 'the bot deleted the note');
    assert.ok(echo.createdAtMs >= deleteCall.receivedAtMs + voiceProgressNoteCleanupBudgetMs - timerToleranceMs, 'and only after the bot had waited the whole bound for it');
    await getCharness().waitFor('the saved set to be emptied', waitTimeoutMs, () => readSavedTransientIds(topicThreadIds.stalledDelete).length === 0);
  });

  it('a note whose send is held lands after the text: the transcript is not held up, and the late note is deleted, never saved as live', async () => {
    closeGate(getEngineGates(getLayout()).transcribe);
    const heldSend = createDeferred();
    fakeTelegram.holdNextResponse('sendMessage', heldSend.promise, checkIsNoteSend(topicThreadIds.heldSend));
    const topic = createTopic(topicThreadIds.heldSend);
    const voice = sendVoice(topicThreadIds.heldSend);
    const note = await topic.waitForMessage('the held note, stored by the fake while the bot still waits for its answer', checkIsNoteAfter(voice));

    openGate(getEngineGates(getLayout()).transcribe);
    // The send is released only after the echo was seen: a bot that waited for it without a bound would never send the echo.
    await topic.waitForMessage('the voice note\'s echo, with the send still unanswered', checkIsEchoAfter(voice));
    heldSend.resolve();
    await waitForNoteDeleted(note);

    assert.deepEqual(readSavedTransientIds(topicThreadIds.heldSend), [], 'the late note was never registered as live');
    assert.equal(countNoteSends(topicThreadIds.heldSend), 1);
  });

  it('a graceful stop of the bot while the note is up (a hot reload) deletes it', async () => {
    closeGate(getEngineGates(getLayout()).transcribe);
    const topic = createTopic(topicThreadIds.gracefulStop);
    const voice = sendVoice(topicThreadIds.gracefulStop);
    const note = await waitForNote(topic, voice);

    await getCharness().stop();

    // The stop returns when the process is gone: the shutdown has deleted the note by then or never will.
    assert.equal(note.isDeleted, true, 'the shutdown deleted the note');
  });

  it('a graceful stop while the note is still being SENT waits for the send and deletes the note that lands', async () => {
    await startCharness();
    closeGate(getEngineGates(getLayout()).transcribe);
    const heldSend = createDeferred();
    fakeTelegram.holdNextResponse('sendMessage', heldSend.promise, checkIsNoteSend(topicThreadIds.stopDuringSend));
    const topic = createTopic(topicThreadIds.stopDuringSend);
    const voice = sendVoice(topicThreadIds.stopDuringSend);
    const note = await topic.waitForMessage('the held note, stored by the fake while the bot still waits for its answer', checkIsNoteAfter(voice));
    assert.notEqual(note.isDeleted, true, 'precondition: the bot does not know the note\'s id yet');

    const stopping = getCharness().stop();
    await getCharness().waitFor('the shutdown to begin', waitTimeoutMs, () => getCharness().output.includes(shutdownLogLine));
    heldSend.resolve();
    await stopping;

    assert.equal(note.isDeleted, true, 'the note that landed while the bot was shutting down is deleted, not stranded');
  });

  it('a kill of the bot while the note is up leaves it on screen, saved with the transient messages; the next boot deletes it', async () => {
    await startCharness();
    closeGate(getEngineGates(getLayout()).transcribe);
    const topic = createTopic(topicThreadIds.kill);
    const voice = sendVoice(topicThreadIds.kill);
    const note = await waitForNote(topic, voice);
    await getCharness().waitFor('the note to be saved with the transient messages', waitTimeoutMs, () => readSavedTransientIds(topicThreadIds.kill).includes(note.message_id));

    getCharness().killSync();
    assert.notEqual(note.isDeleted, true, 'precondition: a killed bot cleans nothing up, the note is still on screen');

    await startCharness();
    await waitForNoteDeleted(note);
    await getCharness().waitFor('the saved set to be emptied', waitTimeoutMs, () => readSavedTransientIds(topicThreadIds.kill).length === 0);
  });

  it('deletes that fail for a bad moment, at the shutdown and at the next boot, keep the id; the next sweep deletes the note', async () => {
    closeGate(getEngineGates(getLayout()).transcribe);
    const topic = createTopic(topicThreadIds.retryChain);
    const voice = sendVoice(topicThreadIds.retryChain);
    const note = await waitForNote(topic, voice);
    const failDeleteOfNote = (): void => fakeTelegram.failNextCall('deleteMessage', 'Internal Server Error', checkIsDeleteOf(note), serverErrorCode);

    // 1. the shutdown: the note's own delete and the sweep's both meet a 5xx
    failDeleteOfNote();
    failDeleteOfNote();
    await getCharness().stop();
    assert.equal(listDeleteCalls(note).length, 2, 'precondition: the shutdown tried twice (the note\'s own cleanup, then the sweep)');
    assert.notEqual(note.isDeleted, true, 'both deletes failed: the note is still on screen');
    assert.ok(readSavedTransientIds(topicThreadIds.retryChain).includes(note.message_id), 'and its id is still recorded — a failed delete does not forget the message');

    // 2. the next boot: its reconciliation meets a 5xx too
    failDeleteOfNote();
    await startCharness();
    await getCharness().waitFor('the boot to try the delete', waitTimeoutMs, () => listDeleteCalls(note).length >= 3);
    assert.notEqual(note.isDeleted, true, 'the third delete failed as well: the note is still on screen');

    // 3. the next sweep: Telegram answers, and the note goes — the id was kept through both failures
    await getCharness().stop();
    assert.equal(note.isDeleted, true, 'the retry deleted the note');
    assert.deepEqual(readSavedTransientIds(topicThreadIds.retryChain), [], 'and its record went with it');
  });
});
