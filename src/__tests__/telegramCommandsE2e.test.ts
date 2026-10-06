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
 *     agent runs
 *   → `/connect` `/disconnect`: the refusals that need no OpenCode
 *   → `/auto_continue_limits` `/compact` `/compact_on_idle`: the picker and its tap,
 *     and the notices while no agent runs
 *   → `/claude` starts the fake agent; `/login` drives the out-of-band sign-in
 *     (`claude auth login` in a pty): the URL out, the pasted code in and its
 *     message deleted, the success notice; a pending `/login` no longer swallows
 *     the topic: a stray message is answered with a waiting hint, `/esc` cancels the
 *     sign-in and the next message reaches the agent; a second `/login` is torn
 *     down by `/quit` (its pty ends)
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
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import type { ScheduleRecord } from '../scheduler/types';
import { fakeClaudeCodeVersionOverrideFileName, fakeClaudeLogFileNames, getFlagValues, getLaunchSessionId, type FakeClaudeTurn } from './jiraE2e/fakeClaudeContract';
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

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
/** A session start through the fake agent. */
const agentStartTimeoutMs = 60 * 1000;
const stopTimeoutMs = 20 * 1000;

/** The code the operator pastes into the sign-in, and the sign-in link the fake CLI prints. */
const pastedLoginCode = 'fake-oauth-code-4711';
const fakeLoginUrl = 'https://claude.example.test/oauth/authorize?code=true';
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

function readLoginPid(): number {
  return Number(fs.readFileSync(path.join(authStateDir, 'login.pid'), 'utf8'));
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
    const picker = await topic.sendAndAwaitReply('/model', 'Claude Code (stream) — 3 models');
    assert.match(picker.text, /1\. sonnet\n2\. opus\n3\. haiku/);
    assert.deepEqual(topic.getKeyboardData(picker), [['mdl_0_0'], ['mdl_0_1'], ['mdl_0_2']]);

    const tapAnswer = await topic.tapAndAwaitAnswer(picker, 'mdl_0_1');
    assert.match(tapAnswer, /No active session/);
    await topic.sendAndAwaitReply('/model 3', 'No active session. Start an agent first.');
  });

  it('/effort offers the levels; a tap is saved for the next session', async () => {
    const picker = await topic.sendAndAwaitReply('/effort', 'Current effort: not set');
    assert.deepEqual(topic.getKeyboardData(picker), [
      ['effort_low', 'effort_medium', 'effort_high'],
      ['effort_xhigh', 'effort_max', 'effort_auto'],
      ['effort_ultracode'],
    ]);
    const answer = await topic.tapAndAwaitAnswer(picker, 'effort_high');
    assert.match(answer, /Level saved/);
  });

  // ── /connect /disconnect ─────────────────────────────────────────────

  it('/connect refuses an invalid provider id; /disconnect says there is nothing to disconnect', async () => {
    await topic.sendAndAwaitReply('/connect bad!id', 'Invalid provider id `bad!id`');
    await topic.sendAndAwaitReply('/disconnect', 'No providers to disconnect.');
  });

  // ── compaction and the limit-resume switch ───────────────────────────

  it('/auto_continue_limits shows the switch; a tap on «Disable» turns it off for the topic', async () => {
    const picker = await topic.sendAndAwaitReply('/auto_continue_limits', 'Auto-resume after a usage limit for this topic: ON');
    assert.deepEqual(topic.getKeyboardData(picker), [['acl_on', 'acl_off']]);
    await topic.tapAndAwaitAnswer(picker, 'acl_off');
    await topic.waitForMessageText('the switch turned off', picker, (text) => text.includes('OFF for this topic'));
    await topic.sendAndAwaitReply('/auto_continue_limits', 'Auto-resume after a usage limit for this topic: OFF');
  });

  it('/compact and /compact_on_idle say an agent session is needed', async () => {
    await topic.sendAndAwaitReply('/compact', 'No active session. Start an agent first');
    await topic.sendAndAwaitReply('/compact_on_idle', 'applies to an active agent session');
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
