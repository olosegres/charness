/**
 * @description The bot's slash commands and their buttons end to end, at PROCESS
 * level: the BUILT charness started the way an isolated instance is started
 * (`scripts/run-isolated.sh` with its own HOME config), serving Telegram only,
 * against a fake Bot API on loopback (`telegramE2e/fakeTelegram.ts`). The test
 * plays the operator in one forum topic and reads back what the bot posted and
 * edited. It is the wiring net under `bot.ts`'s decomposition: every command
 * below must keep answering, and every button keep acting, wherever its handler
 * lives. One flow, in order:
 *
 *   boot → the topic is bound to a folder
 *   → `/reminders`: the hub, the four-step wizard ending in the typed text, the
 *     reminder persisted as a bot-local one, listed, opened and deleted; a command
 *     typed while a wizard is open retires it
 *   → `/thinking` `/tool_results` `/subagent`: a picker per family, a tap persists
 *     the mode and re-renders the picker
 *   → `/model` `/effort`: the pickers, a tap and a typed pick answered while no
 *     agent runs (the default effort and «as in General»: `effortDefaultE2e.test.ts`)
 *   → `/connect` `/disconnect`: the refusals that need no OpenCode
 *   → `/limits` (+ the `/auto_continue_limits` alias) `/compact` `/compact_on_idle`: the picker and its tap,
 *     and the notices while no agent runs; a rung of a backend the list does not use yet (an account next to an
 *     OpenCode model) is asked about first — ✖️ Cancel keeps the list, ✅ Continue adds it — and so is including
 *     such a rung again, while a rung of a backend already in the list goes in at once
 *   → `/stt`: the screen next to the instance's env file (also as `/voice`) with only the engine list, Add engine and Language;
 *     the local engine on its own card (added through Add engine — with the install confirmation, and Cancel writing nothing,
 *     while the model is missing — idle and workers there only, remove from list / remove model
 *     files); a custom server added through the typed
 *     steps (an address with a login is refused and deleted, the pasted key is deleted, neither reaches a bot
 *     message or the output trace), a tap that saves, a keyboard from before a hand edit that is refused, and a
 *     slash command that ends an armed step
 *   → `/claude` starts the fake agent; `/login` drives the out-of-band sign-in
 *     (`claude auth login` in a pty): the URL out, the pasted code in and its
 *     message deleted, the success notice; a pending `/login` no longer swallows
 *     the topic: a stray message is answered with a waiting hint, `/esc` cancels the
 *     sign-in and the next message reaches the agent; a voice note goes through the engine chain of `stt.json`
 *     (a broken engine falls through to a working one, the transcript is echoed and reaches the agent; a chain
 *     with no usable engine names the cause); a second `/login` is torn down by `/quit` (its pty ends)
 *   → `/claude_mode`: a conversation whose CLI is below the lifecycle gate is
 *     refused the per-turn backend (L-D10) by the picker's tap and by the typed
 *     argument alike; the picker's third option (per-turn, lifecycle plan L5), a
 *     tap persists it, `/claude` opens it, a message runs one turn and the
 *     process is stopped right after its result, the next message resumes the
 *     same conversation in a new process
 *
 * Nothing leaves the machine: the Bot API is on loopback, the agent and its
 * `auth` subcommands are fakes. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeSpeechEngine } from './telegramE2e/fakeSpeechEngine';
import { FakeTelegram, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { restartCharnessWithState } from './e2e/fallbackFlowKit';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { getSttPaths } from '../stt/sttInstall';
import { appendInstallProgress, holdInstallLock, releaseInstallLock, writeInstalledMarker } from './fixtures/sttInstallFiles';
import type { FallbackChainEntry } from '../utils/fallbackChain';
import type { ScheduleRecord } from '../scheduler/types';
import { fakeAskQuestion, fakeAskToolName, fakeClaudeCodeVersionOverrideFileName, fakeClaudeLogFileNames, getFlagValues, getLaunchSessionId, type FakeClaudePrompt, type FakeClaudeToolCall, type FakeClaudeTurn } from './jiraE2e/fakeClaudeContract';
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

/** The repo's placeholder group and a topic in it; the operator is its creator. */
const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'proj';
/** The boot's last line before `bot.launch`, which resolves only when polling stops. */
const launchLine = 'Launching Telegraf bot (long polling';
const threadKeyString = `${group.id}:${topicThreadId}`;
/** The second Claude account of the `/limits` step, and the OpenCode model its list starts with. */
const limitsAccount = 'work';
const limitsOpenCodeRung: FallbackChainEntry = { backend: 'opencode', providerId: 'openai', modelId: 'gpt-5' };
const handoverNote = 'The conversation context will be handed over in compacted form.';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
/** A session start through the fake agent. */
const agentStartTimeoutMs = 60 * 1000;
const stopTimeoutMs = 20 * 1000;

/** The code the operator pastes into the sign-in, and the sign-in link the fake CLI prints. */
const pastedLoginCode = 'fake-oauth-code-4711';
const fakeLoginUrl = 'https://claude.example.test/oauth/authorize?code=true';
/** What the operator pastes into the `/stt` key step; plausible for the key check, and found nowhere afterwards. */
const pastedSpeechKey = 'sk-e2e-speech-key-4711-abcdefgh';
/** The login in an address the operator mistakenly types; refused, deleted and kept out of the trace. */
const addressLogin = 'op:pw-4711';
/** A Groq-shaped key for the step a slash command interrupts. */
const strayGroqKey = 'gsk_e2eStrayKey1234567890';
/** What the fake speech engine "recognises": a `KEY-n` label the fake agent records, then a mode and words. */
const voiceTurnLabel = 'VOICE-1';
const voiceTranscript = `${voiceTurnLabel} [fake:answer] remember the milk`;
const voiceFileId = 'voice-e2e-1';
const voiceFileBytes = 2048;
const voiceDurationSeconds = 3;
/** What the flaky engine recognises on its second try; a first reply is a 503. */
const retriedTranscript = 'second try works';
const redactedKeyTraceMarker = '[redacted: speech engine key]';
const redactedAddressTraceMarker = '[redacted: speech engine address]';
/** The localized shortcut line under every "paste the code" prompt. */
const escToCancelHint = '/esc to cancel';
/** A `KEY-n` label the fake agent records in its turn log — names the prompt sent after a cancelled sign-in. */
const afterCancelPromptLabel = 'ESC-1';
/** The two prompts of the per-turn steps (L5): the first runs in a fresh process, the second in a resumed one. */
const perTurnPromptLabels = ['PT-1', 'PT-2'] as const;
/** The prompts of the per-turn pick on an OLD CLI: a fresh start whose process must survive its turn, then a resume through the ensure that must keep the pick. */
const perTurnOldCliPromptLabels = ['PT-0', 'PT-3'] as const;
/** A per-turn stop follows the result at once — far inside the 55-minute idle window, which is not shortened here. */
const perTurnStopTimeoutMs = 15 * 1000;
const perTurnAdapterName = 'claude-per-turn';
/** The last Claude Code version WITHOUT the background-task list: a conversation that ran on it is refused per-turn (L-D10). */
const belowGateClaudeCodeVersion = '2.1.286';
/** The prompt that makes the old-version process report its version (the fake reports it on the first turn's `init`). */
const belowGatePromptLabel = 'OLD-1';
const minAutoStopClaudeCodeVersion = '2.1.287';

/**
 * A stand-in for the `claude auth …` subcommands (the agent itself is the standard fake). `auth login` prints the
 * sign-in link and the "paste the code" prompt, then waits for the code on its terminal; `auth status --json` says
 * "logged in" once a code was entered. It records its pid, so the test can see a torn-down login end.
 */
const fakeClaudeAuthSource = `
const fs = require('fs');
const stateDir = process.env.FAKE_AUTH_STATE_DIR;
const [, , command, action] = process.argv;
if (command === 'auth' && action === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: fs.existsSync(stateDir + '/logged-in') }) + '\\n');
} else if (command === 'auth' && action === 'login') {
  fs.writeFileSync(stateDir + '/login.pid', String(process.pid));
  process.stdout.write('Opening browser to sign in...\\n');
  process.stdout.write('If the browser did not open, visit: ${fakeLoginUrl}\\n\\n');
  process.stdout.write('Paste code here if prompted > ');
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', (line) => {
    fs.writeFileSync(stateDir + '/code.txt', line.trim());
    fs.writeFileSync(stateDir + '/logged-in', '1');
    process.exit(0);
  });
} else {
  process.exit(2);
}
`;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let defaultTmuxSessionsBefore: string[] = [];
let authStateDir = '';
let topic: TopicDriver;
/** The speech engines the voice steps talk to: one that answers, one that always fails, one that fails once. */
let workingSpeechEngine: FakeSpeechEngine;
let brokenSpeechEngine: FakeSpeechEngine;
let flakySpeechEngine: FakeSpeechEngine;
let workingSpeechUrl = '';
let brokenSpeechUrl = '';
let flakySpeechUrl = '';

function getLayout(): IsolatedInstanceLayout {
  if (!layout) throw new Error('the instance layout is not created yet');
  return layout;
}

function getCharness(): IsolatedCharness {
  if (!charness) throw new Error('charness is not started yet');
  return charness;
}

/** The standard fake agent behind `claude`, with `claude auth …` answered by {@link fakeClaudeAuthSource}. */
function writeClaudeLauncherWithAuth(instance: IsolatedInstanceLayout): string {
  const standardLauncher = writeFakeClaudeLauncher(instance, null);
  authStateDir = path.join(instance.testRoot, 'fake-auth-state');
  fs.mkdirSync(authStateDir);
  const authScriptPath = path.join(instance.binDir, 'fakeClaudeAuth.js');
  fs.writeFileSync(authScriptPath, fakeClaudeAuthSource);
  const launcherPath = path.join(instance.binDir, 'claude-with-auth');
  fs.writeFileSync(launcherPath, [
    '#!/bin/sh',
    'if [ "$1" = "auth" ]; then',
    `  export FAKE_AUTH_STATE_DIR='${authStateDir}'`,
    `  exec '${process.execPath}' '${authScriptPath}' "$@"`,
    'fi',
    `exec '${standardLauncher}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return launcherPath;
}

/** A launch the fake agent recorded (`launches.jsonl`): its argv and pid. */
interface FakeLaunch {
  argv: string[];
  isSessionLaunch: boolean;
  pid: number;
}

function getSessionLaunches(): FakeLaunch[] {
  return readJsonLines<FakeLaunch>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.launches)).filter((launch) => launch.isSessionLaunch);
}

/** The last session launch the process `pid` was started by. */
function getSessionLaunchOf(pid: number): FakeLaunch | undefined {
  return getSessionLaunches().filter((launch) => launch.pid === pid).at(-1);
}

/** The slice of the bot's `state.json` the steps read. */
interface PersistedStateSlice {
  schedules?: Record<string, ScheduleRecord>;
  displayPrefs?: Record<string, Record<string, string>>;
  agents?: Record<string, { name?: string; claudeSessionId?: string; jsonStreamTail?: { claudeCodeVersion?: string } }>;
  fallbackChain?: FallbackChainEntry[];
  /** The topic message a running local-engine install reports into; present from the moment a `/stt` tap starts one. */
  sttInstallProgress?: { threadKey: string; messageId: number };
}

function readPersistedState(): PersistedStateSlice {
  return JSON.parse(fs.readFileSync(path.join(getLayout().dataDir, 'state.json'), 'utf8'));
}

function readPersistedTopicPrefs(): Record<string, string> | undefined {
  return readPersistedState().displayPrefs?.[threadKeyString];
}

function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The fake agent's turns whose text carried `label`. */
function getAgentTurns(label: string): FakeClaudeTurn[] {
  return readJsonLines<FakeClaudeTurn>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.turns)).filter((turn) => turn.issueKey === label);
}

/** The user messages the fake agent read that carried `label`, with their whole text. */
function getAgentPrompts(label: string): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts)).filter((prompt) => prompt.issueKey === label);
}

function readLoginPid(): number {
  return Number(fs.readFileSync(path.join(authStateDir, 'login.pid'), 'utf8'));
}

/** `stt.json` sits beside the instance's env file (the symlink-free case of the config location). */
function getSttConfigFilePath(): string {
  return path.join(path.dirname(getLayout().envFile), 'stt.json');
}

/** The slice of `stt.json` the steps read and a hand edit changes. */
interface SttFileSlice {
  language?: string | null;
  engines: Array<{ id: string; kind: string; url?: string; apiKey?: string; isDisabled?: boolean }>;
  gigaam?: { idleMinutes: number; workers: number };
}

function readSttFile(): SttFileSlice {
  return JSON.parse(fs.readFileSync(getSttConfigFilePath(), 'utf8'));
}

/** A hand edit the way an editor saves it: a new file renamed over the old, so the bot's change stamp moves. */
function writeSttFileByHand(file: SttFileSlice): void {
  const tempPath = `${getSttConfigFilePath()}.by-hand`;
  fs.writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`);
  fs.renameSync(tempPath, getSttConfigFilePath());
}

/**
 * Nothing started a local-engine install: no job holds the lock or wrote progress, and no message is remembered as its
 * report. All three change the moment an install starts (the log only says so when it ENDS, minutes later).
 */
function assertNoInstallStarted(): void {
  const paths = getSttPaths(getLayout().dataDir);
  assert.equal(fs.existsSync(paths.lockDir), false, 'no install job holds the lock');
  assert.equal(fs.existsSync(paths.progressFile), false, 'no install job wrote progress');
  assert.equal(readPersistedState().sttInstallProgress, undefined, 'no install message is remembered');
}

/** Everything the output trace has recorded so far (the hourly buckets and their rollovers). */
function readOutputTrace(): string {
  return fs.readdirSync(getLayout().dataDir)
    .filter((name) => /^output-trace-\d+\.jsonl(\.1)?$/.test(name))
    .map((name) => fs.readFileSync(path.join(getLayout().dataDir, name), 'utf8'))
    .join('');
}

/** The callback data on `message`'s keyboard that starts with `prefix` (a `/stt` button without its revision). */
function findButtonData(message: FakeTelegramMessage, prefix: string): string {
  const data = topic.getKeyboardData(message).flat().find((candidate) => candidate.startsWith(prefix));
  assert.ok(data, `a button "${prefix}…" on the keyboard: ${JSON.stringify(topic.getKeyboardData(message))}`);
  return data;
}

/** The command names in the menu the bot published (`setMyCommands`), across all its calls. */
function listMenuCommandNames(): string[] {
  return fakeTelegram.listCalls('setMyCommands').flatMap((call) => {
    const { commands } = call.payload;
    return Array.isArray(commands) ? commands.flatMap((entry) => (typeof entry?.command === 'string' ? [entry.command] : [])) : [];
  });
}

/** Tap the `/stt` button whose data starts with `prefix`. */
async function tapButton(message: FakeTelegramMessage, prefix: string): Promise<string> {
  return topic.tapAndAwaitAnswer(message, findButtonData(message, prefix));
}

function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

describe('Telegram commands end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-cmd-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    workingSpeechEngine = new FakeSpeechEngine(() => ({ status: 200, text: voiceTranscript }));
    brokenSpeechEngine = new FakeSpeechEngine(() => ({ status: 500, body: '{"error":"the engine is down"}' }));
    flakySpeechEngine = new FakeSpeechEngine((requestIndex) => (requestIndex === 0 ? { status: 503, body: '{"error":"busy"}' } : { status: 200, text: retriedTranscript }));
    workingSpeechUrl = await workingSpeechEngine.start();
    brokenSpeechUrl = await brokenSpeechEngine.start();
    flakySpeechUrl = await flakySpeechEngine.start();
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
      CLAUDE_BIN: writeClaudeLauncherWithAuth(layout),
      // A free port nothing listens on: the boot's OpenCode pre-start finds no server and no binary, and gives up.
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
    });
  });

  after(async () => {
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    await workingSpeechEngine?.stop();
    await brokenSpeechEngine?.stop();
    await flakySpeechEngine?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots Telegram-only against the fake Bot API and binds the topic to a folder', async () => {
    charness = new IsolatedCharness(getLayout());
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
  });

  // ── /reminders ───────────────────────────────────────────────────────

  it('/reminders opens the hub: an empty list offers Add and Close', async () => {
    const hub = await topic.sendAndAwaitReply('/reminders', 'No reminders yet.');
    assert.deepEqual(topic.getKeyboardData(hub), [['rmadd'], ['rmclose']]);
  });

  it('the wizard walks its four steps; the typed text creates a bot-local reminder', async () => {
    const screen = await topic.waitForMessage('the hub', (message) => message.text.includes('No reminders yet.'));
    await topic.tapAndAwaitAnswer(screen, 'rmadd');
    await topic.waitForMessageText('step 1', screen, (text) => text.includes('STEP 1/4 · How often?'));
    const onceCallback = topic.getKeyboardData(screen)[0][0];
    assert.match(onceCallback, /^rw_[a-z0-9]+_r_0$/);

    await topic.tapAndAwaitAnswer(screen, onceCallback);
    await topic.waitForMessageText('step 2', screen, (text) => text.includes('STEP 2/4 · Which day?'));
    const tomorrowCallback = topic.getKeyboardData(screen)[0][1];
    await topic.tapAndAwaitAnswer(screen, tomorrowCallback);
    await topic.waitForMessageText('step 3', screen, (text) => text.includes('STEP 3/4 · At what time?'));
    const nineCallback = topic.getKeyboardData(screen)[0][0];
    await topic.tapAndAwaitAnswer(screen, nineCallback);
    await topic.waitForMessageText('step 4', screen, (text) => text.includes('STEP 4/4 · Send the reminder text'));
    assert.match(screen.text, /Time: 09:00/);

    fakeTelegram.pushOperatorMessage(topicThreadId, 'drink water');
    await topic.waitForMessageText('the created screen', screen, (text) => text.includes('✅ Reminder created'));
    assert.match(screen.text, /Text: "drink water"/);

    const schedules = Object.values(readPersistedState().schedules ?? {});
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].deliveryKind, 'reminder', 'a bot-local reminder, never an agent-prompt job');
    assert.equal(schedules[0].threadKey, threadKeyString);
    assert.equal(schedules[0].prompt, 'drink water');
  });

  it('the hub counts the reminder; its list row opens a card, whose Delete removes it', async () => {
    const hub = await topic.sendAndAwaitReply('/reminders', 'Active: 1');
    assert.deepEqual(topic.getKeyboardData(hub), [['rmadd', 'rmlp_0'], ['rmclose']]);

    await topic.tapAndAwaitAnswer(hub, 'rmlp_0');
    await getCharness().waitFor('the list', replyTimeoutMs, () => topic.getKeyboardData(hub).flat().some((data) => /^rmc_\d+$/.test(data)));
    const cardCallback = topic.getKeyboardData(hub).flat().find((data) => /^rmc_\d+$/.test(data));
    assert.ok(cardCallback, 'the list has a row per reminder');
    assert.ok(topic.getKeyboardLabels(hub).flat().some((label) => label.includes('drink water')), 'the row names the reminder');

    await topic.tapAndAwaitAnswer(hub, cardCallback);
    await getCharness().waitFor('the card', replyTimeoutMs, () => topic.getKeyboardData(hub).flat().some((data) => /^rmdel_/.test(data)));
    assert.match(hub.text, /drink water/);
    const deleteCallback = topic.getKeyboardData(hub).flat().find((data) => /^rmdel_/.test(data));
    assert.ok(deleteCallback, 'the card offers Delete');

    await topic.tapAndAwaitAnswer(hub, deleteCallback);
    await getCharness().waitFor('the reminder removed from the state', replyTimeoutMs, () => Object.keys(readPersistedState().schedules ?? {}).length === 0);
    assert.ok(fakeTelegram.callbackAnswers.includes('🗑 Deleted'), 'the delete tap was answered');
  });

  it('a command typed while a wizard is open retires the wizard', async () => {
    const hub = await topic.sendAndAwaitReply('/reminders', 'No reminders yet.');
    await topic.tapAndAwaitAnswer(hub, 'rmadd');
    await topic.waitForMessageText('the wizard', hub, (text) => text.includes('STEP 1/4'));
    await topic.sendAndAwaitReply('/thinking', 'Current thinking mode');
    await topic.waitForMessageText('the wizard retired', hub, (text) => text.includes('✕ Cancelled'));
  });

  // ── display modes ────────────────────────────────────────────────────

  for (const family of [
    { command: '/thinking', header: 'Current thinking mode: minimal', prefix: 'think', answer: 'Thinking: full' },
    { command: '/tool_results', header: 'Current tool-results mode: minimal', prefix: 'toolres', answer: 'Tool results: full' },
    { command: '/subagent', header: 'Current sub-agent mode: minimal', prefix: 'subag', answer: 'Sub-agents: full' },
  ]) {
    it(`${family.command} shows a picker; a tap on «full» persists it and moves the ✓`, async () => {
      const picker = await topic.sendAndAwaitReply(family.command, family.header);
      assert.deepEqual(topic.getKeyboardData(picker), [[`${family.prefix}_minimal`, `${family.prefix}_short`, `${family.prefix}_full`]]);
      assert.deepEqual(topic.getKeyboardLabels(picker), [['minimal ✓', 'short', 'full']]);

      const answer = await topic.tapAndAwaitAnswer(picker, `${family.prefix}_full`);
      assert.equal(answer, family.answer);
      await topic.waitForMessageText('the picker re-rendered', picker, () => topic.getKeyboardLabels(picker)[0]?.[2] === 'full ✓');
      assert.deepEqual(topic.getKeyboardLabels(picker), [['minimal', 'short', 'full ✓']]);
    });
  }

  it('the display modes are persisted per topic', async () => {
    await getCharness().waitFor('the modes persisted', replyTimeoutMs, () => {
      const prefs = readPersistedTopicPrefs();
      return prefs?.thinking === 'full' && prefs?.toolResults === 'full' && prefs?.subagent === 'full';
    });
  });

  it('the typed forms set a mode and reject an unknown word', async () => {
    await topic.sendAndAwaitReply('/thinking short', '✅ Thinking mode: short');
    await topic.sendAndAwaitReply('/tool_results short', '✅ Tool-results mode: short');
    await topic.sendAndAwaitReply('/subagent short', '✅ Sub-agent mode: short');
    await topic.sendAndAwaitReply('/thinking loud', 'Mode `loud` is not valid');
    await getCharness().waitFor('the typed modes persisted', replyTimeoutMs, () => {
      const prefs = readPersistedTopicPrefs();
      return prefs?.thinking === 'short' && prefs?.toolResults === 'short' && prefs?.subagent === 'short';
    });
  });

  // ── /model /effort ───────────────────────────────────────────────────

  it('/model lists the agent\'s models; a tap and a typed number are answered while no agent runs', async () => {
    const picker = await topic.sendAndAwaitReply('/model', 'Claude Code (stream) — 4 models');
    assert.match(picker.text, /1\. fable\n2\. opus\n3\. sonnet\n4\. haiku/);
    assert.deepEqual(topic.getKeyboardData(picker), [['mdl_0_0'], ['mdl_0_1'], ['mdl_0_2'], ['mdl_0_3']]);

    const tapAnswer = await topic.tapAndAwaitAnswer(picker, 'mdl_0_1');
    assert.match(tapAnswer, /No active session/);
    await topic.sendAndAwaitReply('/model 3', 'No active session. Start an agent first.');
  });

  it('/effort offers the levels; a tap is saved for the next session', async () => {
    const picker = await topic.sendAndAwaitReply('/effort', 'Effort in this topic: medium — as in General');
    assert.deepEqual(topic.getKeyboardData(picker), [
      ['effort_low', 'effort_medium', 'effort_high'],
      ['effort_xhigh', 'effort_max', 'effort_auto'],
      ['effort_ultracode'],
      ['effortsame'],
    ]);
    const answer = await topic.tapAndAwaitAnswer(picker, 'effort_high');
    assert.match(answer, /Level saved/);
    await topic.waitForMessageText('the picker shows the pick as the topic\'s own', picker, (text) => text === '⚙️ Effort in this topic: high — set for this topic');
  });

  // ── /connect /disconnect ─────────────────────────────────────────────

  it('/connect refuses an invalid provider id; /disconnect says there is nothing to disconnect', async () => {
    await topic.sendAndAwaitReply('/connect bad!id', 'Invalid provider id `bad!id`');
    await topic.sendAndAwaitReply('/disconnect', 'No providers to disconnect.');
  });

  // ── compaction and the limit-resume switch ───────────────────────────

  it('/limits shows the short screen (the old /auto_continue_limits and /fallback open it too); a setting button opens its sub-menu and «OFF» there turns waiting off for the topic', async () => {
    const sources = '🔁 as in General · ⏳ as in General';
    const screen = await topic.sendAndAwaitReply('/limits', sources);
    assert.match(screen.text, /Runs on: .*\n🔁 as in General · ⏳ as in General\n\n🪜 No fallback models yet/);
    assert.doesNotMatch(screen.text, /How it works|Fallback models —|Wait for the reset and continue/, 'the long prose is gone: the settings are on the buttons');
    assert.ok(screen.text.length < 300, `the screen stays a few lines (${screen.text.length} characters)`);
    assert.deepEqual(topic.getKeyboardData(screen).slice(-2), [['fbk_set_asw'], ['fbk_set_wait']]);
    assert.deepEqual(topic.getKeyboardLabels(screen).slice(-2), [['🔁 Auto switch: OFF'], ['⏳ Wait for reset: ON']]);
    await topic.sendAndAwaitReply('/auto_continue_limits', sources);
    await topic.sendAndAwaitReply('/fallback', sources);
    await topic.tapAndAwaitAnswer(screen, 'fbk_set_wait');
    await topic.waitForMessageText('the setting sub-menu', screen, (text) => text === '⏳ Wait for the reset and continue');
    assert.deepEqual(topic.getKeyboardLabels(screen), [['ON'], ['OFF'], ['As in General (ON) ✓'], ['⬅️ Back']]);
    await topic.tapAndAwaitAnswer(screen, 'fbk_wait_off');
    await topic.waitForMessageText('the screen re-rendered', screen, (text) => text.includes('🔁 as in General · ⏳ set for this topic'));
    await topic.sendAndAwaitReply('/auto_continue_limits off', 'Auto-resume after a usage limit: OFF for this topic');
    await topic.sendAndAwaitReply('/limits wait same', 'this topic follows General (ON)');
  });

  it('/limits asks before a rung of a backend the list does not use yet joins automatic switching: ✖️ Cancel keeps the list, ✅ Continue adds it; a rung of a backend already there goes in at once; including a left-out rung of a new backend asks again', async () => {
    // No OpenCode catalog here to add from, so the list starts with the OpenCode rung the state holds and the other
    // backend is a second Claude account, signed in.
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: limitsAccount, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.claudeProfiles = { ...persisted.claudeProfiles, [limitsAccount]: { createdAt: new Date().toISOString(), loggedIn: true, email: 'work@example.com', subscriptionType: 'max' } };
      persisted.fallbackChain = [limitsOpenCodeRung];
    });
    const screen = await topic.sendAndAwaitReply('/limits', 'Runs on:');
    const waitForButton = async (description: string, pattern: RegExp): Promise<string> => {
      let found = '';
      await getCharness().waitFor(description, replyTimeoutMs, () => {
        found = topic.getKeyboardData(screen).flat().find((data) => pattern.test(data)) ?? '';
        return found !== '';
      });
      return found;
    };
    const askToAddAccount = async (modelPattern: RegExp): Promise<void> => {
      await topic.tapAndAwaitAnswer(screen, 'fbk_add');
      await topic.tapAndAwaitAnswer(screen, await waitForButton('the account step', new RegExp(`^fbk_addc_${limitsAccount}$`)));
      await topic.tapAndAwaitAnswer(screen, await waitForButton('the model step', modelPattern));
    };
    const readChain = (): FallbackChainEntry[] => readPersistedState().fallbackChain ?? [];

    // The other backend: asked first, Cancel keeps the list.
    await askToAddAccount(new RegExp(`^fbk_addcm_${limitsAccount}_-$`));
    await topic.waitForMessageText('the question', screen, (text) => text.startsWith('➕ Add'));
    assert.equal(screen.text, `➕ Add Claude · ${limitsAccount} · topic's model to the fallback list?\n${handoverNote}`);
    assert.deepEqual(topic.getKeyboardLabels(screen), [['✅ Continue', '✖️ Cancel']]);
    assert.match(topic.getKeyboardData(screen)[0][0], /^fbk_addok_[0-9a-f]{8}$/, 'the revision of the list is baked into Continue');
    assert.equal(topic.getKeyboardData(screen)[0][1], 'fbk_back');
    assert.deepEqual(readChain(), [limitsOpenCodeRung], 'nothing is added before the answer');
    await topic.tapAndAwaitAnswer(screen, 'fbk_back');
    await topic.waitForMessageText('the list back', screen, (text) => text.includes('Runs on:'));
    assert.deepEqual(readChain(), [limitsOpenCodeRung], 'Cancel changed nothing');

    // The same add, confirmed: the rung joins the list and the screen is the list again.
    await askToAddAccount(new RegExp(`^fbk_addcm_${limitsAccount}_-$`));
    await topic.waitForMessageText('the question', screen, (text) => text.startsWith('➕ Add'));
    const continueData = topic.getKeyboardData(screen)[0][0];
    assert.equal(await topic.tapAndAwaitAnswer(screen, continueData), `✅ Added: Claude · ${limitsAccount} · topic's model`);
    await getCharness().waitFor('the rung in state.json', replyTimeoutMs, () => readChain().length === 2);
    assert.deepEqual(readChain()[1], { backend: 'claude', profile: limitsAccount, model: null });
    await topic.waitForMessageText('the list re-rendered', screen, (text) => text.includes('Runs on:'));
    assert.equal(await topic.tapAndAwaitAnswer(screen, continueData), 'The list changed since this keyboard was posted — it is re-rendered.', 'a Continue tap from before the change adds nothing');
    assert.equal(readChain().length, 2);

    // A rung of a backend the list already has goes in at once: no question.
    await askToAddAccount(new RegExp(`^fbk_addcm_${limitsAccount}_(?!-$)[a-z0-9._-]+$`));
    await getCharness().waitFor('the second Claude rung in state.json', replyTimeoutMs, () => readChain().length === 3);
    assert.ok(!screen.text.includes(handoverNote), 'no question for a backend already in the list');
    assert.equal(readChain()[2].backend, 'claude');

    // Leave the OpenCode rung out, then include it again: Claude is the only backend left in automatic switching, so OpenCode is new.
    await topic.tapAndAwaitAnswer(screen, await waitForButton('the OpenCode rung', /^fbk_op_0_[0-9a-f]{8}$/));
    await topic.tapAndAwaitAnswer(screen, await waitForButton('the rung\'s detail view', /^fbk_tg_0_[0-9a-f]{8}$/));
    await getCharness().waitFor('the OpenCode rung left out', replyTimeoutMs, () => readChain()[0].disabled === true);
    await topic.waitForMessageText('the detail view of the left-out rung', screen, (text) => text.includes('Left out of automatic switching'));
    await topic.tapAndAwaitAnswer(screen, await waitForButton('the include button', /^fbk_tg_0_[0-9a-f]{8}$/));
    await topic.waitForMessageText('the question', screen, (text) => text.startsWith('➕ Include'));
    assert.equal(screen.text, `➕ Include OpenCode · openai/gpt-5 in automatic switching?\n${handoverNote}`);
    assert.deepEqual(topic.getKeyboardLabels(screen), [['✅ Continue', '✖️ Cancel']]);
    assert.match(topic.getKeyboardData(screen)[0][0], /^fbk_tgok_0_[0-9a-f]{8}$/);
    assert.match(topic.getKeyboardData(screen)[0][1], /^fbk_op_0_[0-9a-f]{8}$/, 'Cancel returns to the rung\'s detail view');
    assert.equal(readChain()[0].disabled, true, 'still left out before the answer');
    await topic.tapAndAwaitAnswer(screen, topic.getKeyboardData(screen)[0][1]);
    await topic.waitForMessageText('the detail view', screen, (text) => text.includes('Left out of automatic switching'));
    assert.equal(readChain()[0].disabled, true, 'Cancel changed nothing');

    await topic.tapAndAwaitAnswer(screen, await waitForButton('the detail view of the left-out rung', /^fbk_tg_0_[0-9a-f]{8}$/));
    await topic.waitForMessageText('the question again', screen, (text) => text.startsWith('➕ Include'));
    await topic.tapAndAwaitAnswer(screen, topic.getKeyboardData(screen)[0][0]);
    await getCharness().waitFor('the OpenCode rung included again', replyTimeoutMs, () => readChain()[0].disabled !== true);

    await topic.sendAndAwaitReply('/limits clear', 'The list of fallback models is empty now.');
    assert.deepEqual(readChain(), []);
  });

  it('/compact and /compact_on_idle say an agent session is needed', async () => {
    await topic.sendAndAwaitReply('/compact', 'No active session. Start an agent first');
    await topic.sendAndAwaitReply('/compact_on_idle', 'applies to an active agent session');
  });

  // ── /stt ─────────────────────────────────────────────────────────────

  it('/stt opens the screen, also as /voice: it names the settings file beside the env file and offers only Add engine, Language and Close — nothing of the local engine', async () => {
    const screen = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
    assert.ok(screen.text.includes(`no file yet (${getSttConfigFilePath()})`), screen.text);
    assert.match(screen.text, /No engines yet/);
    assert.deepEqual(topic.getKeyboardLabels(screen), [['➕ Add engine'], ['🌐 Language: auto'], ['✖️ Close']]);
    assert.ok(findButtonData(screen, 'stt_ad_').length <= 64, 'the callback data fits Telegram\'s 64 bytes');
    await topic.sendAndAwaitReply('/voice', '🎙 Voice recognition');
    const menuCommands = listMenuCommandNames();
    assert.ok(menuCommands.includes('stt'), 'the menu lists /stt');
    assert.ok(!menuCommands.includes('voice') && !menuCommands.includes('speech'), 'the aliases stay hidden');
  });

  it('Add engine → GigaAM while the model is not installed: the confirmation says what it costs, nothing is written, Cancel leaves everything as it was', async () => {
    const dataDir = getLayout().dataDir;
    assert.equal(fs.existsSync(getSttPaths(dataDir).markerFile), false, 'the model is not installed');
    const readFileOrNull = (): string | null => (fs.existsSync(getSttConfigFilePath()) ? fs.readFileSync(getSttConfigFilePath(), 'utf8') : null);
    const fileBefore = readFileOrNull();

    const screen = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
    await tapButton(screen, 'stt_ad_');
    await topic.waitForMessageText('the add menu', screen, (text) => text.includes('Which engine do you want to add?'));
    assert.ok(topic.getKeyboardLabels(screen).flat().includes('GigaAM (local)'), 'offered although it is not installed');
    await tapButton(screen, 'stt_an_gg_');
    await topic.waitForMessageText('the install confirmation', screen, (text) => text.startsWith('Enable local recognition?'));
    assert.match(screen.text, /About 400 MB are downloaded/);
    assert.match(screen.text, /up to about 0\.9 GB for long ones/);
    assert.match(screen.text, /Russian only/);
    assert.deepEqual(topic.getKeyboardLabels(screen).flat(), ['⬇️ Install', 'Cancel']);
    assert.equal(readFileOrNull(), fileBefore, 'asking writes nothing');

    await tapButton(screen, 'stt_bk_'); // Cancel
    await topic.waitForMessageText('the main screen again', screen, (text) => text.includes('Engines, tried in this order') || text.includes('No engines yet'));
    assert.deepEqual(topic.getKeyboardLabels(screen).flat(), ['➕ Add engine', '🌐 Language: auto', '✖️ Close']);
    assert.equal(readFileOrNull(), fileBefore, 'cancelling writes nothing');
    assertNoInstallStarted();
    assert.equal(fs.existsSync(getSttPaths(dataDir).markerFile), false);
  });

  it('the local engine lives on its own card: Add engine → GigaAM opens it, idle and workers are there and nowhere else, "Remove from list" keeps the files, "Remove model files" asks, deletes them and the row', async () => {
    writeInstalledMarker(getLayout().dataDir); // the model files are in place: adding needs no install
    const screen = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
    await tapButton(screen, 'stt_ad_');
    await topic.waitForMessageText('the add menu', screen, (text) => text.includes('Which engine do you want to add?'));
    assert.ok(topic.getKeyboardLabels(screen).flat().includes('GigaAM (local)'), 'offered while it is not in the list');
    await tapButton(screen, 'stt_an_gg_');
    await topic.waitForMessageText('GigaAM\'s card', screen, (text) => text.includes('GigaAM v3 — local, Russian only'));
    assert.match(screen.text, /Status: ready · stopped/);
    assert.match(screen.text, /up to ~0\.9 GB on a long voice note/);
    const cardLabels = topic.getKeyboardLabels(screen).flat();
    for (const label of ['⏱ Timeout: 10s+25%', '⏱ Exit after idle: 15 min', '⚙️ Workers: 4', 'Remove from list', '🗑 Remove model files', '⬅️ Back']) {
      assert.ok(cardLabels.includes(label), `${label} in ${cardLabels.join(' | ')}`);
    }
    assert.deepEqual(readSttFile().engines.map((engine) => engine.kind), ['gigaam']);

    // Idle exit is set here and nowhere else; the picker returns to the card.
    await tapButton(screen, 'stt_im_g_');
    await topic.waitForMessageText('the idle picker', screen, (text) => text.includes('How long may the local engine sit idle'));
    await tapButton(screen, 'stt_is_g_5_');
    await topic.waitForMessageText('the card again', screen, (text) => text.includes('GigaAM v3 — local, Russian only'));
    assert.equal(readSttFile().gigaam?.idleMinutes, 5);
    assert.ok(topic.getKeyboardLabels(screen).flat().includes('⏱ Exit after idle: 5 min'));
    await tapButton(screen, 'stt_im_g_');
    await topic.waitForMessageText('the idle picker', screen, (text) => text.includes('How long may the local engine sit idle'));
    await tapButton(screen, 'stt_is_g_15_');
    await topic.waitForMessageText('the card again', screen, (text) => text.includes('Status: ready'));

    // Workers likewise: the picker, a save, back on the card — and back to 4.
    await tapButton(screen, 'stt_wm_g_');
    await topic.waitForMessageText('the workers picker', screen, (text) => text.includes('How many pieces of a long voice note'));
    await tapButton(screen, 'stt_ws_g_8_');
    await topic.waitForMessageText('the card again', screen, (text) => text.includes('Status: ready'));
    assert.equal(readSttFile().gigaam?.workers, 8);
    assert.ok(topic.getKeyboardLabels(screen).flat().includes('⚙️ Workers: 8'));
    await tapButton(screen, 'stt_wm_g_');
    await topic.waitForMessageText('the workers picker', screen, (text) => text.includes('How many pieces of a long voice note'));
    await tapButton(screen, 'stt_ws_g_4_');
    await topic.waitForMessageText('the card again', screen, (text) => text.includes('Status: ready'));
    assert.equal(readSttFile().gigaam?.workers, 4);

    // The main screen: the state rides on the row, no local control anywhere.
    await tapButton(screen, 'stt_bk_');
    await topic.waitForMessageText('the main screen', screen, (text) => text.includes('Engines, tried in this order'));
    assert.deepEqual(topic.getKeyboardLabels(screen).flat(), ['1. GigaAM (local) · stopped · 10s+25% · ✓', '➕ Add engine', '🌐 Language: auto', '✖️ Close']);

    // Remove from list: the files stay, the main screen forgets the engine, Add engine brings it back with no install.
    await tapButton(screen, 'stt_oe_g_');
    await topic.waitForMessageText('the card', screen, (text) => text.includes('GigaAM v3'));
    await tapButton(screen, 'stt_ra_g_');
    await topic.waitForMessageText('the confirmation', screen, (text) => text.includes('Its files stay on disk'));
    await tapButton(screen, 'stt_rd_g_');
    await topic.waitForMessageText('the list without it', screen, (text) => text.includes('No engines yet'));
    assert.deepEqual(readSttFile().engines, []);
    assert.ok(fs.existsSync(getSttPaths(getLayout().dataDir).markerFile), 'the model files are still there');
    assert.deepEqual(topic.getKeyboardLabels(screen).flat(), ['➕ Add engine', '🌐 Language: auto', '✖️ Close']);
    await tapButton(screen, 'stt_ad_');
    await topic.waitForMessageText('the add menu', screen, (text) => text.includes('Which engine do you want to add?'));
    await tapButton(screen, 'stt_an_gg_');
    await topic.waitForMessageText('GigaAM\'s card', screen, (text) => text.includes('GigaAM v3 — local, Russian only'));

    // Remove model files: asks first (Cancel returns to the card), then the files and the row go.
    await tapButton(screen, 'stt_fa_g_');
    await topic.waitForMessageText('the confirmation', screen, (text) => text.includes('Remove the model files'));
    assert.ok(fs.existsSync(getSttPaths(getLayout().dataDir).markerFile), 'asking removes nothing');
    await tapButton(screen, 'stt_oe_g_');
    await topic.waitForMessageText('the card after Cancel', screen, (text) => text.includes('GigaAM v3 — local, Russian only'));
    await tapButton(screen, 'stt_fa_g_');
    await topic.waitForMessageText('the confirmation', screen, (text) => text.includes('Remove the model files'));
    const answer = await tapButton(screen, 'stt_fd_g_');
    assert.equal(answer, 'Local engine files removed.');
    await topic.waitForMessageText('the main screen without the engine', screen, (text) => text.includes('No engines yet'));
    assert.equal(fs.existsSync(getSttPaths(getLayout().dataDir).markerFile), false, 'the model files are gone');
    assert.deepEqual(readSttFile().engines, []);
    assert.deepEqual(topic.getKeyboardLabels(screen).flat(), ['➕ Add engine', '🌐 Language: auto', '✖️ Close']);
  });

  it('the card of a listed GigaAM whose files are missing: Install asks, Cancel returns to the card, nothing is written and no install starts', async () => {
    const dataDir = getLayout().dataDir;
    assert.equal(fs.existsSync(getSttPaths(dataDir).markerFile), false, 'the model is not installed');
    const fileBefore = readSttFile();
    assertNoInstallStarted();

    // A list that names GigaAM without its files makes the bot fetch the model by itself, the moment it reads the file.
    // A job that is already running (the lock, as the boot flows hold it) keeps the bot from launching the real one.
    holdInstallLock(dataDir);
    try {
      appendInstallProgress(dataDir, { phase: 'downloadingModel', detail: '12/216 MB', bytesDownloaded: 12 * 1024 * 1024 });
      writeSttFileByHand({ ...fileBefore, engines: [{ id: 'g', kind: 'gigaam' }] });
      const screen = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
      await tapButton(screen, 'stt_oe_g_');
      await topic.waitForMessageText('the card of the engine being installed', screen, (text) => text.includes('GigaAM v3 — local, Russian only'));
      assert.match(screen.text, /Status: installing/);
      const installingLabels = topic.getKeyboardLabels(screen).flat();
      assert.ok(installingLabels.includes('📊 Show install progress'), installingLabels.join(' | '));
      assert.ok(!installingLabels.includes('⬇️ Install'), 'nothing to start while a job runs');
      assert.ok(!installingLabels.includes('🗑 Remove model files'), 'and nothing to remove');

      // The job ends without leaving the model behind: the files are still missing and the bot starts nothing of its own.
      fs.rmSync(getSttPaths(dataDir).progressFile, { force: true });
      releaseInstallLock(dataDir);
      await tapButton(screen, 'stt_bk_');
      await topic.waitForMessageText('the main screen', screen, (text) => text.includes('Engines, tried in this order'));
      await tapButton(screen, 'stt_oe_g_');
      await topic.waitForMessageText('the card of the engine that is not installed', screen, (text) => text.includes('Status: not installed'));
      const cardLabels = topic.getKeyboardLabels(screen).flat();
      assert.ok(cardLabels.includes('⬇️ Install'), cardLabels.join(' | '));
      assert.ok(!cardLabels.includes('🗑 Remove model files'), 'no files to remove');
      assert.deepEqual(readSttFile().engines, [{ id: 'g', kind: 'gigaam' }]);
      const fileWithEngine = fs.readFileSync(getSttConfigFilePath(), 'utf8');

      await tapButton(screen, 'stt_ec_g_'); // Install
      await topic.waitForMessageText('the install confirmation', screen, (text) => text.startsWith('Enable local recognition?'));
      assert.deepEqual(topic.getKeyboardLabels(screen).flat(), ['⬇️ Install', 'Cancel']);
      assert.equal(fs.readFileSync(getSttConfigFilePath(), 'utf8'), fileWithEngine, 'asking writes nothing');

      await tapButton(screen, 'stt_oe_g_'); // Cancel: back to the card the confirmation was opened from
      await topic.waitForMessageText('the card again', screen, (text) => text.includes('GigaAM v3 — local, Russian only'));
      assert.match(screen.text, /Status: not installed/);
      assert.ok(topic.getKeyboardLabels(screen).flat().includes('⬇️ Install'));
      assert.equal(fs.readFileSync(getSttConfigFilePath(), 'utf8'), fileWithEngine, 'cancelling writes nothing');
      assertNoInstallStarted();
    } finally {
      releaseInstallLock(dataDir);
      fs.rmSync(getSttPaths(dataDir).progressFile, { force: true });
      writeSttFileByHand(fileBefore);
    }
  });

  it('a custom server through the typed steps: the address with a login and the pasted key are deleted and never reach a bot message or the output trace', async () => {
    await topic.sendAndAwaitReply('/trace on', 'Tracing enabled for this thread');
    const screen = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
    await tapButton(screen, 'stt_ad_');
    await topic.waitForMessageText('the add menu', screen, (text) => text.includes('Which engine do you want to add?'));
    await tapButton(screen, 'stt_an_ur_');
    await topic.waitForMessageText('the address prompt', screen, (text) => text.includes('Send the address of the server'));

    const loginMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `http://${addressLogin}@stt.example.test:8000`);
    await topic.waitForMessage('the login refusal', (message) => message.message_id > loginMessageId && message.text.includes('Do not put a login or key into the address'));
    assert.equal(fakeTelegram.getMessage(loginMessageId)?.isDeleted, true, 'an address with a login is deleted from the topic');

    const workingBaseUrl = workingSpeechUrl.replace('/v1/audio/transcriptions', '');
    fakeTelegram.pushOperatorMessage(topicThreadId, workingBaseUrl);
    await topic.waitForMessageText('the key question', screen, (text) => text.includes('Does this server need an API key?'));
    await tapButton(screen, 'stt_ku_y_');
    await topic.waitForMessageText('the key prompt', screen, (text) => text.includes('Paste the API key now'));
    const keyMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, pastedSpeechKey);
    await topic.waitForMessageText('the key saved', screen, (text) => text.includes('Key saved'));
    assert.equal(fakeTelegram.getMessage(keyMessageId)?.isDeleted, true, 'the pasted key is deleted from the topic');

    const file = readSttFile();
    assert.deepEqual(file.engines.map((engine) => [engine.kind, engine.url, engine.apiKey]), [['url', workingSpeechUrl, pastedSpeechKey]], 'a base address is completed to the transcription endpoint');
    assert.equal(fs.statSync(getSttConfigFilePath()).mode & 0o777, 0o600, 'the file with the key is private');

    const everythingTheBotSaid = JSON.stringify(topic.listMessages().map((message) => message.text));
    assert.ok(!everythingTheBotSaid.includes(pastedSpeechKey) && !everythingTheBotSaid.includes(addressLogin), 'no bot message repeats the key or the login');
    await getCharness().waitFor('the redacted previews in the output trace', replyTimeoutMs, () => {
      const trace = readOutputTrace();
      return trace.includes(redactedKeyTraceMarker) && trace.includes(redactedAddressTraceMarker);
    });
    const trace = readOutputTrace();
    for (const secret of [pastedSpeechKey, addressLogin, 'pw-4711@']) assert.ok(!trace.includes(secret), `the output trace does not contain ${secret}`);
  });

  it('a tap saves to stt.json, and a keyboard from before a hand edit is refused without writing anything', async () => {
    const screen = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
    await tapButton(screen, 'stt_oe_');
    await topic.waitForMessageText('the engine card', screen, (text) => text.includes('Ready.'));
    const cloudLabels = topic.getKeyboardLabels(screen).flat();
    assert.ok(cloudLabels.includes('⏱ Timeout: 10s+25%'), cloudLabels.join(' | '));
    assert.ok(!cloudLabels.some((label) => /Exit after idle|Workers|model files|Remove from list/.test(label)), `a cloud engine\'s card has the common controls and its key only: ${cloudLabels.join(' | ')}`);
    await tapButton(screen, 'stt_us_');
    await topic.waitForMessageText('the card re-rendered as switched off', screen, (text) => text.includes('Not in use'));
    assert.equal(readSttFile().engines[0].isDisabled, true, 'the tap is saved');
    await tapButton(screen, 'stt_us_');
    await topic.waitForMessageText('the card re-rendered as in use', screen, (text) => text.includes('Ready.'));
    assert.equal(readSttFile().engines[0].isDisabled, undefined, 'and switched back');

    const staleButton = findButtonData(screen, 'stt_us_');
    writeSttFileByHand({ ...readSttFile(), language: 'ru' });
    const answer = await topic.tapAndAwaitAnswer(screen, staleButton);
    assert.equal(answer, 'The settings changed — refreshed.');
    await topic.waitForMessageText('the main screen after the refusal', screen, (text) => text.includes('Language: ru'));
    assert.equal(readSttFile().engines[0].isDisabled, undefined, 'the stale tap wrote nothing');
  });

  it('a slash command ends an armed key step: the retired prompt says so and the next key-like message is no longer taken for it', async () => {
    const screen = await topic.sendAndAwaitReply('/stt', '🎙 Voice recognition');
    await tapButton(screen, 'stt_ad_');
    await topic.waitForMessageText('the add menu', screen, (text) => text.includes('Which engine do you want to add?'));
    await tapButton(screen, 'stt_an_gq_');
    await topic.waitForMessageText('the key prompt', screen, (text) => text.includes('Paste the API key now'));

    await topic.sendAndAwaitReply('/thinking', 'Current thinking mode');
    await topic.waitForMessageText('the prompt retired', screen, (text) => text === 'Cancelled.');
    const enginesBefore = readSttFile().engines.length;
    const strayMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, strayGroqKey);
    await topic.waitForMessage('the plain message handled as ordinary text', (message) => message.message_id > strayMessageId && message.text.includes('Run /claude or /opencode'));
    assert.notEqual(fakeTelegram.getMessage(strayMessageId)?.isDeleted, true, 'no key step is armed: the message is not taken for a key');
    assert.equal(readSttFile().engines.length, enginesBefore, 'nothing was saved');
  });

  // ── /login ───────────────────────────────────────────────────────────

  it('/claude starts the fake agent in the topic', async () => {
    await topic.sendAndAwaitReply('/claude', 'ready in');
  });

  it('/login relays the sign-in link; the pasted code reaches the CLI, its message is deleted and the sign-in is confirmed', async () => {
    const urlMessage = await topic.sendAndAwaitReply('/login', fakeLoginUrl);
    assert.match(urlMessage.text, /To sign in to Claude/);

    const codeMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, pastedLoginCode);
    await topic.waitForMessage('the code relayed', (message) => message.text.includes('Login code relayed to Claude'));
    await topic.waitForMessage('the sign-in confirmed', (message) => message.text.includes('✅ Signed in to Claude.'));
    assert.equal(fakeTelegram.getMessage(codeMessageId)?.isDeleted, true, 'the code message was deleted — it is a single-use secret');
    assert.equal(fs.readFileSync(path.join(authStateDir, 'code.txt'), 'utf8'), pastedLoginCode, 'the code reached the CLI');
  });

  it('a pending /login does not swallow the topic: the link offers /esc, a stray message gets the waiting hint, /esc cancels and the next message reaches the agent', async () => {
    fs.rmSync(path.join(authStateDir, 'logged-in'), { force: true });
    const urlMessage = await topic.sendAndAwaitReply('/login', fakeLoginUrl);
    assert.ok(urlMessage.text.endsWith(escToCancelHint), 'the link message ends with the /esc shortcut');
    const loginPid = readLoginPid();
    assert.ok(checkIsProcessAlive(loginPid), 'the sign-in CLI is waiting for the code');

    const strayMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, 'are you still there? this is not a code');
    const hint = await topic.waitForMessage('the waiting hint', (message) => message.message_id > strayMessageId && message.text.includes('Waiting for the login code'));
    assert.ok(hint.text.endsWith(escToCancelHint), 'the hint offers /esc');
    assert.notEqual(fakeTelegram.getMessage(strayMessageId)?.isDeleted, true, 'a stray message is not a secret and stays');
    assert.ok(checkIsProcessAlive(loginPid), 'the stray message did not reach the sign-in CLI');

    await topic.sendAndAwaitReply('/esc', 'Login cancelled');
    await getCharness().waitFor('the sign-in CLI to end', stopTimeoutMs, () => !checkIsProcessAlive(loginPid));

    fakeTelegram.pushOperatorMessage(topicThreadId, `${afterCancelPromptLabel} [fake:answer] hello again`);
    await getCharness().waitFor('the prompt to reach the agent', agentStartTimeoutMs, () => getAgentTurns(afterCancelPromptLabel).length > 0);
  });

  // ── a voice note ─────────────────────────────────────────────────────

  it('a voice note goes through stt.json: the broken engine in front falls through to the working one, the transcript is echoed and reaches the agent', async () => {
    // A hand edit, applied by the next voice note with no restart: the broken engine goes first.
    const file = readSttFile();
    writeSttFileByHand({ ...file, engines: [{ id: 'u9', kind: 'url', url: brokenSpeechUrl }, ...file.engines] });
    fakeTelegram.registerFile(voiceFileId, Buffer.alloc(voiceFileBytes, 7));

    const voiceMessageId = fakeTelegram.pushOperatorVoice(topicThreadId, voiceFileId, voiceDurationSeconds);
    await topic.waitForMessage('the transcript echo', (message) => message.message_id > voiceMessageId && message.text === `🎤 ${voiceTranscript}`);
    await getCharness().waitFor('the transcript to reach the agent', agentStartTimeoutMs, () => getAgentTurns(voiceTurnLabel).length > 0);
    assert.ok(getAgentPrompts(voiceTurnLabel).some((prompt) => prompt.text.includes('remember the milk')), 'the agent got the recognised words');

    assert.deepEqual(fakeTelegram.downloadedFilePaths, [`voice/${voiceFileId}.oga`], 'the voice file was fetched from the file endpoint');
    assert.equal(brokenSpeechEngine.requests.length, 1, 'a failing engine that is not the last is tried once');
    assert.equal(workingSpeechEngine.requests.length, 1);
    const [request] = workingSpeechEngine.requests;
    assert.equal(request.path, '/v1/audio/transcriptions');
    assert.equal(request.authorization, `Bearer ${pastedSpeechKey}`, 'the key typed in /stt is the bearer token');
    assert.equal(request.language, 'ru', 'the language set by the hand edit reaches the engine');
    assert.equal(request.model, 'whisper-1');
    assert.equal(request.audioBytes, voiceFileBytes, 'the downloaded audio is what was uploaded');

    const brokenName = `url:${new URL(brokenSpeechUrl).host}`;
    const workingName = `url:${new URL(workingSpeechUrl).host}`;
    const botOutput = getCharness().output;
    assert.ok(botOutput.includes(`[transcribe] ${brokenName} failed (`), 'the fallback is logged with the failing engine');
    assert.ok(botOutput.includes(`falling back to ${workingName}`));
    assert.ok(botOutput.includes(`[transcribe] ok via ${workingName} in `));
    assert.ok(botOutput.includes(`(${voiceDurationSeconds}s audio)`), 'Telegram\'s voice duration reaches the recognition');
    assert.ok(!botOutput.includes(pastedSpeechKey), 'the key is nowhere in the bot output');
  });

  it('the last engine retries a temporary failure after telling the topic, and the retry succeeds', async () => {
    const file = readSttFile();
    writeSttFileByHand({ ...file, engines: [{ id: 'f1', kind: 'url', url: flakySpeechUrl }] });
    const voiceMessageId = fakeTelegram.pushOperatorVoice(topicThreadId, voiceFileId, voiceDurationSeconds);
    await topic.waitForMessage('the retry notice', (message) => message.message_id > voiceMessageId && message.text.includes('Retrying in 5 s'));
    await topic.waitForMessage('the transcript after the retry', (message) => message.message_id > voiceMessageId && message.text === `🎤 ${retriedTranscript}`);
    assert.equal(flakySpeechEngine.requests.length, 2, 'one failed try, one retry');
  });

  it('a voice note with no usable engine is told why: listed engines that cannot be used, or none set up', async () => {
    const file = readSttFile();
    writeSttFileByHand({ ...file, engines: [{ id: 'k1', kind: 'groq' }] });
    const unusableMessageId = fakeTelegram.pushOperatorVoice(topicThreadId, voiceFileId, voiceDurationSeconds);
    await topic.waitForMessage('the unusable-engines notice', (message) => message.message_id > unusableMessageId && message.text.includes('none of the listed speech engines can be used right now'));

    writeSttFileByHand({ ...file, engines: [] });
    const emptyMessageId = fakeTelegram.pushOperatorVoice(topicThreadId, voiceFileId, voiceDurationSeconds);
    await topic.waitForMessage('the nothing-set-up notice', (message) => message.message_id > emptyMessageId && message.text.includes('Voice needs a speech-recognition engine'));
    assert.equal(workingSpeechEngine.requests.length, 1, 'no engine was asked for these two');
  });

  it('a pending question\'s buttons: the tap on a short option is answered with it whole; on one longer than a toast holds, with its start — the question message keeps the whole answer, nothing is posted beside it, and the agent gets the whole label', async () => {
    const shortAskPrompt = 'ASK-1';
    const longAskPrompt = 'ASK-2';
    const askAndTap = async (promptLabel: string, callbackData: string): Promise<{ toast: string; question: FakeTelegramMessage }> => {
      const sentMessageId = fakeTelegram.pushOperatorMessage(topicThreadId, `${promptLabel} [fake:ask] ask me something`);
      const question = await topic.waitForMessage(`the question of ${promptLabel}`, (message) => message.message_id > sentMessageId && message.text.includes(fakeAskQuestion.question) && message.reply_markup !== undefined);
      assert.deepEqual(topic.getKeyboardData(question), [['qa_0_0'], ['qa_0_1']], 'one button per option');
      return { toast: await topic.tapAndAwaitAnswer(question, callbackData), question };
    };
    const getAskOutcome = (promptLabel: string): string | undefined =>
      readJsonLines<FakeClaudeToolCall>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.toolCalls)).find((call) => call.issueKey === promptLabel && call.tool === fakeAskToolName)?.outcome;

    const short = await askAndTap(shortAskPrompt, 'qa_0_0');
    assert.equal(short.toast, fakeAskQuestion.shortOptionLabel, 'a label that fits is the toast, whole');
    await getCharness().waitFor('the short answer to reach the agent', agentStartTimeoutMs, () => getAskOutcome(shortAskPrompt) !== undefined);
    assert.equal(getAskOutcome(shortAskPrompt), fakeAskQuestion.shortOptionLabel);

    assert.ok(fakeAskQuestion.longOptionLabel.length > 200, 'precondition: the long label is longer than a toast holds');
    const long = await askAndTap(longAskPrompt, 'qa_0_1');
    assert.ok(long.toast.length <= 200 && long.toast.endsWith('…'), `the toast fits: ${long.toast.length} characters`);
    assert.ok(fakeAskQuestion.longOptionLabel.startsWith(long.toast.slice(0, -1)), 'it is the start of the label');
    await topic.waitForMessageText('the question message edited to the whole answer', long.question, (text) => text === `✅ ${fakeAskQuestion.header}: ${fakeAskQuestion.longOptionLabel}`);
    await getCharness().waitFor('the long answer to reach the agent', agentStartTimeoutMs, () => getAskOutcome(longAskPrompt) !== undefined);
    assert.equal(getAskOutcome(longAskPrompt), fakeAskQuestion.longOptionLabel, 'the agent got the whole label, not the toast');
    // The answer is in the topic once: the edited question message. The tap posted nothing beside it.
    assert.equal(topic.listMessages().filter((message) => message.text.includes(fakeAskQuestion.longOptionLabel)).length, 1, 'the whole label appears once');
  });

  it('/quit tears down a pending /login: its pty ends', async () => {
    fs.rmSync(path.join(authStateDir, 'logged-in'), { force: true });
    await topic.sendAndAwaitReply('/login', fakeLoginUrl);
    const loginPid = readLoginPid();
    assert.ok(checkIsProcessAlive(loginPid), 'the sign-in CLI is waiting for the code');

    fakeTelegram.pushOperatorMessage(topicThreadId, '/quit');
    await getCharness().waitFor('the sign-in CLI to end', stopTimeoutMs, () => !checkIsProcessAlive(loginPid));
  });

  // ── /claude_mode: the per-turn lifecycle (L5) ────────────────────────

  it('a conversation whose CLI is below the gate is refused the per-turn backend — by the tap and by the typed argument (L-D10)', async () => {
    const versionOverridePath = path.join(getLayout().fakeStateDir, fakeClaudeCodeVersionOverrideFileName);
    fs.writeFileSync(versionOverridePath, belowGateClaudeCodeVersion);
    try {
      await topic.sendAndAwaitReply('/claude', 'ready in');
      fakeTelegram.pushOperatorMessage(topicThreadId, `${belowGatePromptLabel} [fake:answer] a turn on the old CLI`);
      await getCharness().waitFor('the prompt to reach the old-version agent', agentStartTimeoutMs, () => getAgentTurns(belowGatePromptLabel).length === 1);
      await getCharness().waitFor('the old CLI version known to the bot', replyTimeoutMs, () => readPersistedState().agents?.[threadKeyString]?.jsonStreamTail?.claudeCodeVersion === belowGateClaudeCodeVersion);
      const oldProcessPid = getSessionLaunches().at(-1)?.pid;
      assert.ok(oldProcessPid, 'the old-version process was launched');

      const picker = await topic.sendAndAwaitReply('/claude_mode', 'Claude Code backend — current:');
      await topic.tapAndAwaitAnswer(picker, `ccmode_${perTurnAdapterName}`);
      const tapRefusal = await topic.waitForMessage('the tap refused', (message) => message.text.includes('Per-turn needs Claude Code'));
      assert.match(tapRefusal.text, new RegExp(`${minAutoStopClaudeCodeVersion} or newer — this conversation last ran ${belowGateClaudeCodeVersion}`));
      assert.match(tapRefusal.text, /The backend was not changed/);

      const typedRefusal = await topic.sendAndAwaitReply('/claude_mode perturn', 'Per-turn needs Claude Code');
      assert.match(typedRefusal.text, /The backend was not changed/);

      assert.equal(readPersistedState().agents?.[threadKeyString]?.name, 'claude-json-stream', 'the pick stayed on the idle lifecycle');
      assert.ok(checkIsProcessAlive(oldProcessPid), 'the running process was neither stopped nor replaced');
      assert.equal(getSessionLaunches().at(-1)?.pid, oldProcessPid, 'no new process was started by the refused switches');
      assert.ok(getCharness().output.includes(`[lifecycle] ${threadKeyString}: per-turn refused — Claude Code ${belowGateClaudeCodeVersion} is below ${minAutoStopClaudeCodeVersion}`));

      await topic.sendAndAwaitReply('/quit', 'stopped');
      await getCharness().waitFor('the old-version process to end', stopTimeoutMs, () => !checkIsProcessAlive(oldProcessPid));
    } finally {
      fs.rmSync(versionOverridePath, { force: true });
    }
  });

  it('/claude_mode shows the third option; a tap persists the per-turn backend for the topic', async () => {
    const picker = await topic.sendAndAwaitReply('/claude_mode', 'Claude Code backend — current:');
    assert.deepEqual(topic.getKeyboardData(picker), [['ccmode_claude-json-stream'], [`ccmode_${perTurnAdapterName}`], ['ccmode_claude']], 'three backends, per-turn in the middle');
    assert.ok(topic.getKeyboardLabels(picker).flat().some((label) => label.includes('Per-turn')), 'the option is labelled');

    const answer = await topic.tapAndAwaitAnswer(picker, `ccmode_${perTurnAdapterName}`);
    assert.match(answer, /Switching/);
    await topic.waitForMessage('the pick recorded for the next start', (message) => message.text.includes('Per-turn') && message.text.includes('applies on next start'));
    await getCharness().waitFor('the per-turn backend persisted', replyTimeoutMs, () => readPersistedState().agents?.[threadKeyString]?.name === perTurnAdapterName);
  });

  it('a per-turn pick started on an old CLI keeps the pick and runs the session without the per-turn stop; a newer CLI returns to per-turn by itself (L-D10)', async () => {
    const versionOverridePath = path.join(getLayout().fakeStateDir, fakeClaudeCodeVersionOverrideFileName);
    fs.writeFileSync(versionOverridePath, belowGateClaudeCodeVersion);
    const outputBefore = getCharness().output.length;
    try {
      await topic.sendAndAwaitReply('/claude', 'ready in');
      fakeTelegram.pushOperatorMessage(topicThreadId, `${perTurnOldCliPromptLabels[0]} [fake:answer] a per-turn prompt on the old CLI`);
      await getCharness().waitFor('the prompt to reach the old-version agent', agentStartTimeoutMs, () => getAgentTurns(perTurnOldCliPromptLabels[0]).length === 1);
      const [turn] = getAgentTurns(perTurnOldCliPromptLabels[0]);
      const sessionId = getLaunchSessionId(getSessionLaunchOf(turn.pid)?.argv ?? []);
      await getCharness().waitFor('the old CLI version known to the bot', replyTimeoutMs, () => readPersistedState().agents?.[threadKeyString]?.jsonStreamTail?.claudeCodeVersion === belowGateClaudeCodeVersion);
      // The per-turn stop would have taken the process well inside this window on a supported CLI.
      await new Promise<void>((resolve) => setTimeout(resolve, perTurnStopTimeoutMs));
      assert.ok(checkIsProcessAlive(turn.pid), 'an old CLI is never auto-stopped: the process survives its turn');
      const sinceStart = (): string => getCharness().output.slice(outputBefore);
      assert.ok(!sinceStart().includes(`[compact-on-idle] ${threadKeyString} process stopped`), 'no stop');
      assert.ok(sinceStart().includes(`[lifecycle] ${threadKeyString} is not auto-stopped: Claude Code ${minAutoStopClaudeCodeVersion} or newer is needed`), 'the stop gate said why, once');

      // The process dies on its own (the session id is kept): the next message resumes the conversation THROUGH the
      // ensure, where a refused per-turn pick must stay the pick and run this session without the per-turn stop.
      process.kill(turn.pid, 'SIGKILL');
      await topic.waitForMessage('the session-ended notice', (message) => message.text.includes('session ended'));
      fakeTelegram.pushOperatorMessage(topicThreadId, `${perTurnOldCliPromptLabels[1]} [fake:answer] resumed on the old CLI`);
      await getCharness().waitFor('the prompt to reach a resumed old-version agent', agentStartTimeoutMs, () => getAgentTurns(perTurnOldCliPromptLabels[1]).length === 1);
      const [resumedTurn] = getAgentTurns(perTurnOldCliPromptLabels[1]);
      assert.deepEqual(getFlagValues(getSessionLaunchOf(resumedTurn.pid)?.argv ?? [], '--resume'), [sessionId], 'the same conversation, resumed');
      assert.ok(sinceStart().includes(`[lifecycle] ${threadKeyString}: per-turn refused — Claude Code ${belowGateClaudeCodeVersion} is below ${minAutoStopClaudeCodeVersion}`));
      assert.ok(sinceStart().includes(`[lifecycle] ${threadKeyString}: the per-turn pick is kept; this session runs without the per-turn stop`));
      assert.equal(readPersistedState().agents?.[threadKeyString]?.name, perTurnAdapterName, 'the per-turn pick is kept — not rewritten to the idle lifecycle');
      await new Promise<void>((resolve) => setTimeout(resolve, perTurnStopTimeoutMs));
      assert.ok(checkIsProcessAlive(resumedTurn.pid), 'the resumed old-CLI process survives its turn too');

      await topic.sendAndAwaitReply('/quit', 'stopped');
      await getCharness().waitFor('the old-version process to end', stopTimeoutMs, () => !checkIsProcessAlive(resumedTurn.pid));
    } finally {
      fs.rmSync(versionOverridePath, { force: true });
    }
  });

  it('a message runs one turn on the per-turn backend and the process is stopped right after its result', async () => {
    // From here: the previous step killed an old-CLI process on purpose, which IS an unexpected exit.
    const outputBefore = getCharness().output.length;
    await topic.sendAndAwaitReply('/claude', 'ready in');
    fakeTelegram.pushOperatorMessage(topicThreadId, `${perTurnPromptLabels[0]} [fake:answer] first per-turn prompt`);
    await getCharness().waitFor('the first prompt to reach the agent', agentStartTimeoutMs, () => getAgentTurns(perTurnPromptLabels[0]).length === 1);
    const [firstTurn] = getAgentTurns(perTurnPromptLabels[0]);
    await getCharness().waitFor('the process stopped right after its result', perTurnStopTimeoutMs, () => !checkIsProcessAlive(firstTurn.pid));
    assert.ok(getCharness().output.includes(`[compact-on-idle] ${threadKeyString} process stopped; the session sleeps`), 'the per-turn stop is the idle stop\'s teardown');
    assert.ok(!getCharness().output.slice(outputBefore).includes(`[ClaudeJson] session ${threadKeyString} exited unexpectedly`));
    assert.ok(readPersistedState().agents?.[threadKeyString]?.claudeSessionId, 'the session id is kept: the conversation sleeps');
  });

  it('the next message resumes the sleeping conversation in a new process, which is stopped again after its turn', async () => {
    const [firstTurn] = getAgentTurns(perTurnPromptLabels[0]);
    const sessionId = getLaunchSessionId(getSessionLaunchOf(firstTurn.pid)?.argv ?? []);
    assert.ok(sessionId, 'the first launch named its conversation');

    fakeTelegram.pushOperatorMessage(topicThreadId, `${perTurnPromptLabels[1]} [fake:answer] second per-turn prompt`);
    await getCharness().waitFor('the second prompt to reach a resumed agent', agentStartTimeoutMs, () => getAgentTurns(perTurnPromptLabels[1]).length === 1);
    const [secondTurn] = getAgentTurns(perTurnPromptLabels[1]);
    assert.notEqual(secondTurn.pid, firstTurn.pid, 'a new process per turn');
    assert.deepEqual(getFlagValues(getSessionLaunchOf(secondTurn.pid)?.argv ?? [], '--resume'), [sessionId], 'the same conversation, resumed');
    await getCharness().waitFor('the second process stopped after its turn', perTurnStopTimeoutMs, () => !checkIsProcessAlive(secondTurn.pid));
  });
});
