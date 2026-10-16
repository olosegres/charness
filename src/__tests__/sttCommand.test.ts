/**
 * @description The `/stt` command module end to end, with fake Telegram ports and a real `stt.json` on disk:
 * the screen opens, taps edit and save (a stale keyboard is refused), a key is accepted only when plausible,
 * deleted from the topic BEFORE it is used and never appears in any message the bot sends, a custom address is
 * completed and asked for a key, the typed steps end by command, cancel or timeout, "Enable local recognition"
 * hands its message to the install job and puts the engine first, and removing the files drops the engine.
 */

import { test, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Context } from 'telegraf';
import { createStt, sttInputTimeoutMs, type SttPorts } from '../connectors/telegram/commands/stt';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { SessionKey } from '../sessionKey';
import type { SttInstallProgressMessage } from '../state';
import { getSttPaths, gigaamPinnedRequirements, gigaamScriptVersion, type SttInstallProgress } from '../stt/sttInstall';
import { computeSttRevision } from '../stt/sttScreenPlan';
import {
  createEmptySttConfig,
  loadSttConfig,
  resetSttConfigCache,
  resolveSttSettings,
  saveSttConfig,
  type SttConfigFile,
} from '../stt/sttSettings';
import type { SttInstallJobOptions } from '../stt/sttAutoInstall';

const sampleKey = 'gsk_sampleSecretKey1234567890';
const key: SessionKey = makeTelegramKey(-1001111111111, 77);
const messageId = 900;

interface SentMessage {
  id: number;
  text: string;
  buttons: string[];
}

let dataDir = '';
let configPath = '';
let sent: SentMessage[] = [];
let edits: Array<{ id: number; text: string; buttons: string[] }> = [];
let deleted: number[] = [];
let storedInstallMessage: SttInstallProgressMessage | null = null;
let ownerCalls: string[] = [];
let installRuns: Array<{ progressReports: SttInstallProgress[] }> = [];
let installOutcome: SttInstallProgress = { phase: 'done', detail: '', bytesDownloaded: 0 };
let nextMessageId = 1000;
let commandHandler: ((ctx: Context, key: SessionKey) => Promise<void>) | null = null;
let actionHandler: ((ctx: Context) => Promise<void>) | null = null;
let isAuthorised = true;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-command-'));
  configPath = path.join(dataDir, 'config', 'stt.json');
  resetSttConfigCache();
  sent = [];
  edits = [];
  deleted = [];
  storedInstallMessage = null;
  ownerCalls = [];
  installRuns = [];
  installOutcome = { phase: 'done', detail: '', bytesDownloaded: 0 };
  nextMessageId = 1000;
  commandHandler = null;
  actionHandler = null;
  isAuthorised = true;
});

afterEach(() => {
  mock.timers.reset();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function buttonsOf(extra: object | undefined): string[] {
  const markup = extra as { reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } } | undefined;
  return (markup?.reply_markup?.inline_keyboard ?? []).flat().map((button) => `${button.text}|${button.callback_data}`);
}

function writeInstalledMarker(): void {
  const paths = getSttPaths(dataDir);
  fs.mkdirSync(path.dirname(paths.venvPython), { recursive: true });
  fs.writeFileSync(paths.venvPython, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(paths.markerFile, JSON.stringify({ scriptVersion: gigaamScriptVersion, pins: gigaamPinnedRequirements, installedAt: 'now' }));
}

function createFeature(overrides: Partial<SttPorts> = {}) {
  const ports: SttPorts = {
    bot: {
      action: (_pattern: RegExp, handler: (ctx: Context) => Promise<void>) => { actionHandler = handler; },
    } as unknown as SttPorts['bot'],
    command: (_names, handler) => { commandHandler = handler as unknown as (ctx: Context, key: SessionKey) => Promise<void>; },
    getState: () => ({
      getSttInstallProgressMessage: () => storedInstallMessage,
      setSttInstallProgressMessage: async (message: SttInstallProgressMessage | null) => { storedInstallMessage = message; },
    }) as unknown as ReturnType<SttPorts['getState']>,
    replyToThread: async (_key, text, extra) => {
      const id = nextMessageId++;
      sent.push({ id, text, buttons: buttonsOf(extra) });
      return id;
    },
    editThreadMessage: async (_key, id, text, extra) => { edits.push({ id, text, buttons: buttonsOf(extra) }); return true; },
    deleteThreadMessage: async (_key, id) => { deleted.push(id); },
    authoriseContext: async () => (isAuthorised ? key : null),
    withThreadLocale: (_key, fn) => fn(),
    getConfigPath: () => configPath,
    getDataDir: () => dataDir,
    getResolvedSettings: () =>
      resolveSttSettings(loadSttConfig(configPath), {
        isGigaamInstalled: fs.existsSync(getSttPaths(dataDir).markerFile),
        isGigaamInstalling: false,
        isGigaamUnhealthy: false,
        hasOwnerContext: true,
      }, { getGigaamEndpoint: async () => ({ url: 'http://127.0.0.1:1/x', model: 'm' }) }),
    getOwnerContext: () => ({ pid: 1, startToken: 't' }),
    owner: {
      getStatus: async () => ({ state: 'notRunning' as const }),
      stop: async () => { ownerCalls.push('stop'); },
      applySettingsChange: async () => { ownerCalls.push('applySettingsChange'); },
      resetSpawnGuard: () => { ownerCalls.push('resetSpawnGuard'); },
    },
    installJobs: {
      start: async ({ reportTo }: SttInstallJobOptions) => {
        const run = { progressReports: [{ phase: 'downloadingModel', detail: '1/216 MB', bytesDownloaded: 1 } as SttInstallProgress] };
        installRuns.push(run);
        for (const report of run.progressReports) await reportTo(report);
        if (installOutcome.phase === 'done') writeInstalledMarker();
        await reportTo(installOutcome);
        return installOutcome;
      },
    },
    ...overrides,
  };
  const feature = createStt(ports);
  feature.registerSttCommands();
  feature.registerSttCallbacks();
  return feature;
}

interface FakeCallbackContext {
  ctx: Context;
  answers: Array<string | undefined>;
}

function tapContext(data: string): FakeCallbackContext {
  const answers: Array<string | undefined> = [];
  const ctx = {
    match: [data],
    callbackQuery: { data, message: { message_id: messageId } },
    answerCbQuery: async (text?: string) => { answers.push(text); },
  } as unknown as Context;
  return { ctx, answers };
}

async function tap(action: string, args: Array<string | number> = [], revision?: string): Promise<FakeCallbackContext> {
  const currentRevision = revision ?? computeSttRevision(loadSttConfig(configPath).config ?? createEmptySttConfig());
  const data = ['stt', action, ...args, currentRevision].join('_');
  const fake = tapContext(data);
  assert.ok(actionHandler, 'the callbacks are registered');
  await actionHandler(fake.ctx);
  return fake;
}

function writeConfig(overrides: Partial<SttConfigFile>): void {
  saveSttConfig(configPath, { ...createEmptySttConfig(), ...overrides });
}

function readConfig(): SttConfigFile {
  resetSttConfigCache();
  return loadSttConfig(configPath).config ?? createEmptySttConfig();
}

const lastEdit = (): { id: number; text: string; buttons: string[] } => {
  const edit = edits.at(-1);
  assert.ok(edit, 'a message was edited');
  return edit;
};

test('/stt opens the main screen as a new message in the topic, whatever the topic is', async () => {
  writeConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  createFeature();
  assert.ok(commandHandler);
  await commandHandler({} as Context, key);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Voice recognition/);
  assert.ok(sent[0].buttons.some((button) => button.startsWith('1. Groq · 10s+25% · ✓|stt_oe_q1_')), sent[0].buttons.join('\n'));
  assert.ok(sent[0].buttons.some((button) => button.startsWith('🖥 Enable local recognition|stt_ec_')));
  assert.ok(!sent.some((message) => message.text.includes(sampleKey)), 'the key is never printed');
});

test('a tap that is not authorised is refused with the standard answer and changes nothing', async () => {
  writeConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  createFeature();
  isAuthorised = false;
  const { answers } = await tap('us', ['q1']);
  assert.equal(answers.length, 1);
  assert.notEqual(answers[0], undefined);
  assert.equal(readConfig().engines[0].isDisabled, undefined);
  assert.deepEqual(edits, []);
});

test('engine card taps save: use / don\'t use, a timeout preset, the order — and each save tells the owner', async () => {
  writeConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }, { id: 'o1', kind: 'openai', apiKey: 'sk-sampleSecretKey12345' }] });
  createFeature();

  await tap('us', ['q1']);
  assert.equal(readConfig().engines[0].isDisabled, true);
  assert.match(lastEdit().text, /Not in use/);

  await tap('tb', ['q1', 30]);
  assert.deepEqual(readConfig().engines[0].timeout, { baseSeconds: 30, percentOfDuration: 25 });
  assert.ok(lastEdit().buttons.some((button) => button.startsWith('30 s ✓|')));

  await tap('dn', ['q1']);
  assert.deepEqual(readConfig().engines.map((engine) => engine.id), ['o1', 'q1']);
  assert.equal(ownerCalls.filter((call) => call === 'applySettingsChange').length, 3);
});

test('a keyboard from before a hand edit is refused: the toast says so, the main screen re-renders, nothing is written', async () => {
  writeConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  createFeature();
  const staleRevision = computeSttRevision(readConfig());
  writeConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }], language: 'ru' }); // a hand edit
  const before = fs.readFileSync(configPath, 'utf8');

  const { answers } = await tap('us', ['q1'], staleRevision);
  assert.deepEqual(answers, ['The settings changed — refreshed.']);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.match(lastEdit().text, /Language: ru/);
});

test('adding Groq: the key step is armed, an implausible paste stays visible and re-arms, a plausible one is deleted FIRST and saved', async () => {
  writeConfig({});
  const feature = createFeature();
  await tap('ad');
  await tap('an', ['gq']);
  assert.match(lastEdit().text, /Paste the API key now/);
  assert.equal(feature.checkIsAwaitingSttInput(key), true);
  assert.equal(feature.checkIsAwaitingSttKey(key), true);

  await feature.submitSttInput(key, 'я перезагрузил сервис', 501);
  assert.deepEqual(deleted, [], 'not a secret: it stays visible');
  assert.equal(sent.at(-1)?.text.startsWith('❌ That does not look like an API key'), true);
  assert.equal(feature.checkIsAwaitingSttKey(key), true, 'still armed');
  assert.deepEqual(readConfig().engines, []);

  await feature.submitSttInput(key, `  ${sampleKey}\n`, 502);
  assert.deepEqual(deleted, [502], 'the pasted key is removed from the topic');
  assert.equal(feature.checkIsAwaitingSttKey(key), false);
  const saved = readConfig();
  assert.deepEqual(saved.engines.map((engine) => [engine.id, engine.kind, engine.apiKey]), [['q1', 'groq', sampleKey]]);
  assert.match(lastEdit().text, /Key saved/);
  assert.match(lastEdit().text, /1\/1 · Groq/);

  const everythingSent = JSON.stringify([...sent, ...edits]);
  assert.ok(!everythingSent.includes(sampleKey), 'the key never appears in anything the bot sent or edited');
  assert.ok(!everythingSent.includes('gsk_'), 'not even a prefix of it');
});

test('changing the key of an existing engine replaces it and shows no key', async () => {
  writeConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  const feature = createFeature();
  await tap('ky', ['q1']);
  const replacement = 'gsk_replacementKey9876543210';
  await feature.submitSttInput(key, replacement, 777);
  assert.deepEqual(deleted, [777]);
  assert.equal(readConfig().engines[0].apiKey, replacement);
  assert.ok(!JSON.stringify([...sent, ...edits]).includes(replacement));
});

test('a custom server: the address is completed, then "does it need a key?" — no saves it, yes arms the key', async () => {
  writeConfig({});
  const feature = createFeature();
  await tap('ad');
  await tap('an', ['ur']);
  assert.match(lastEdit().text, /Send the address of the server/);

  await feature.submitSttInput(key, 'not an address', 601);
  assert.match(sent.at(-1)?.text ?? '', /not an http\(s\) address/);
  await feature.submitSttInput(key, 'http://me:pw@stt.local/v1', 602);
  assert.deepEqual(deleted, [602], 'an address with a login in it is removed from the topic');
  assert.match(sent.at(-1)?.text ?? '', /Do not put a login or key into the address/);

  await feature.submitSttInput(key, 'http://stt.local:8000', 603);
  assert.deepEqual(deleted, [602], 'a plain address stays');
  assert.match(lastEdit().text, /Does this server need an API key/);
  assert.equal(feature.checkIsAwaitingSttInput(key), false, 'the next plain message is not swallowed while the buttons are awaited');

  await tap('ku', ['n']);
  assert.deepEqual(readConfig().engines, [{ id: 'u1', kind: 'url', url: 'http://stt.local:8000/v1/audio/transcriptions' }]);
});

test('a custom server with a key: yes arms the paste for the new engine and the key lands on it, deleted from the topic', async () => {
  writeConfig({});
  const feature = createFeature();
  await tap('an', ['ur']);
  await feature.submitSttInput(key, 'https://stt.example/v1', 701);
  await tap('ku', ['y']);
  assert.equal(feature.checkIsAwaitingSttKey(key), true);
  await feature.submitSttInput(key, sampleKey, 702);
  assert.deepEqual(deleted, [702]);
  assert.deepEqual(readConfig().engines, [{ id: 'u1', kind: 'url', url: 'https://stt.example/v1/audio/transcriptions', apiKey: sampleKey }]);
  assert.ok(!JSON.stringify([...sent, ...edits]).includes(sampleKey));
});

test('a command, the cancel button and a silent teardown each end an armed step; a plain message is then no longer swallowed', async () => {
  writeConfig({});
  const feature = createFeature();
  await tap('an', ['gq']);
  await feature.cancelSttInput(key);
  assert.equal(feature.checkIsAwaitingSttInput(key), false);
  assert.equal(lastEdit().text, 'Cancelled.');

  await tap('an', ['gq']);
  await tap('cn');
  assert.equal(feature.checkIsAwaitingSttKey(key), false);
  assert.match(lastEdit().text, /Voice recognition/, 'the cancel button returns to the main screen');

  await tap('an', ['gq']);
  const editsBefore = edits.length;
  await feature.cancelSttInput(key, { isSilent: true });
  assert.equal(feature.checkIsAwaitingSttInput(key), false);
  assert.equal(edits.length, editsBefore, 'a teardown says nothing');
});

test('an armed step expires after ten minutes: the prompt is retired and a late paste is no longer taken for a key', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  writeConfig({});
  const feature = createFeature();
  await tap('an', ['gq']);
  assert.equal(feature.checkIsAwaitingSttKey(key), true);
  mock.timers.tick(sttInputTimeoutMs - 1);
  assert.equal(feature.checkIsAwaitingSttKey(key), true);
  mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(feature.checkIsAwaitingSttKey(key), false);
  assert.match(lastEdit().text, /Timed out/);
});

test('re-arming (a wrong paste) restarts the ten minutes instead of leaving the old timer to cut the new try short', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  writeConfig({});
  const feature = createFeature();
  await tap('an', ['gq']);
  mock.timers.tick(sttInputTimeoutMs - 1000);
  await feature.submitSttInput(key, 'too short', 801);
  mock.timers.tick(5000);
  assert.equal(feature.checkIsAwaitingSttKey(key), true, 'the first timer was replaced');
});

test('Enable local recognition: confirm screen, then Install hands the SAME message to the job; on success the engine is first', async () => {
  writeConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  createFeature();
  await tap('ec');
  assert.match(lastEdit().text, /400 MB/);
  assert.match(lastEdit().text, /Russian only/);
  assert.ok(lastEdit().buttons.some((button) => button.startsWith('⬇️ Install|stt_ei_')));

  await tap('ei');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(installRuns.length, 1);
  const installEdits = edits.filter((edit) => edit.id === messageId);
  assert.ok(installEdits.some((edit) => edit.text.includes('Downloading the model 1/216 MB')), installEdits.map((edit) => edit.text).join(' | '));
  assert.ok(installEdits.some((edit) => edit.text.includes('Local recognition is ready')));
  assert.deepEqual(readConfig().engines.map((engine) => engine.id), ['g', 'q1'], 'the local engine joins first');
  assert.ok(ownerCalls.includes('applySettingsChange'));
  assert.ok(lastEdit().buttons.some((button) => button.startsWith('⚙️ Settings|stt_bk_')), 'the finished message offers the settings');
  assert.equal(storedInstallMessage, null, 'the install message is forgotten once it ended');
  assert.ok(sent.length === 0, 'no extra message: the install lives in the one the user tapped');
});

test('a failed install shows the error and the log tail with Retry, and leaves the list alone', async () => {
  writeConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  installOutcome = { phase: 'failed', detail: '', bytesDownloaded: 0, error: 'the model check failed', logTail: ['boom'] };
  createFeature();
  await tap('ei');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const finalEdit = lastEdit();
  assert.match(finalEdit.text, /could not be installed: the model check failed/);
  assert.match(finalEdit.text, /boom/);
  assert.ok(finalEdit.buttons.some((button) => button.startsWith('🔁 Retry|stt_er_')));
  assert.deepEqual(readConfig().engines.map((engine) => engine.id), ['q1']);
});

test('the install button is refused once the engine is installed (a stale screen)', async () => {
  writeConfig({});
  writeInstalledMarker();
  createFeature();
  const { answers } = await tap('ei');
  assert.deepEqual(answers, ['The settings changed — refreshed.']);
  assert.equal(installRuns.length, 0);
});

test('Remove local engine files: asks first, then stops the sidecar, deletes the install and drops the engine from the list', async () => {
  writeConfig({ engines: [{ id: 'g', kind: 'gigaam' }, { id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  writeInstalledMarker();
  createFeature();
  await tap('fa');
  assert.match(lastEdit().text, /Remove the local engine files/);
  assert.ok(fs.existsSync(getSttPaths(dataDir).markerFile), 'asking removes nothing');

  const { answers } = await tap('fd');
  assert.deepEqual(answers, ['Local engine files removed.']);
  assert.deepEqual(ownerCalls.slice(0, 1), ['stop']);
  assert.equal(fs.existsSync(getSttPaths(dataDir).markerFile), false);
  assert.equal(fs.existsSync(getSttPaths(dataDir).venvDir), false);
  assert.deepEqual(readConfig().engines.map((engine) => engine.id), ['q1']);
});

test('"Try again now" lifts the spawn-storm guard; Close deletes the screen; the language and idle pickers save', async () => {
  writeConfig({ engines: [{ id: 'g', kind: 'gigaam' }] });
  writeInstalledMarker();
  createFeature();

  await tap('rt');
  assert.ok(ownerCalls.includes('resetSpawnGuard'));

  await tap('ls', ['ru']);
  assert.equal(readConfig().language, 'ru');
  await tap('is', [0]);
  assert.equal(readConfig().gigaam.idleMinutes, 0);
  await tap('ws', [8]);
  assert.equal(readConfig().gigaam.workers, 8);

  await tap('cl');
  assert.deepEqual(deleted, [messageId]);
});

test('an unwritable stt.json answers "could not write", changes nothing and does not touch the process', async () => {
  writeConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  createFeature();
  const before = fs.readFileSync(configPath, 'utf8');
  fs.mkdirSync(`${configPath}.${process.pid}.tmp`); // the temp file of the atomic write cannot be created
  const editsBefore = edits.length;
  const { answers } = await tap('us', ['q1']);
  assert.deepEqual(answers, ['❌ Could not write the settings file — see the bot log.']);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.equal(edits.length, editsBefore, 'the screen is not re-rendered as if it had worked');
  assert.ok(!ownerCalls.includes('applySettingsChange'));
});
