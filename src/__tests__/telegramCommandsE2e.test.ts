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
 *     message deleted, the success notice; a second `/login` is torn down by
 *     `/quit` (its pty ends)
 *
 * Nothing leaves the machine: the Bot API is on loopback, the agent and its
 * `auth` subcommands are fakes. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import type { ScheduleRecord } from '../scheduler/types';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFreeFixedPort,
  getFreePort,
  IsolatedCharness,
  listTmuxSessions,
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
const flowMarginMs = 60 * 1000;
const flowTimeoutMs = bootTimeoutMs + 60 * replyTimeoutMs + agentStartTimeoutMs + stopTimeoutMs + flowMarginMs;

/** The code the operator pastes into the sign-in, and the sign-in link the fake CLI prints. */
const pastedLoginCode = 'fake-oauth-code-4711';
const fakeLoginUrl = 'https://claude.example.test/oauth/authorize?code=true';

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
  const standardLauncher = writeFakeClaudeLauncher(instance);
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

function readPersistedState(): { schedules?: Record<string, ScheduleRecord>; displayPrefs?: Record<string, Record<string, string>> } {
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

function removeInstanceSync(): void {
  removeIsolatedInstanceSync(layout, charness);
}

describe('Telegram commands end to end: built charness, fake Bot API', { timeout: flowTimeoutMs }, () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-cmd-', [projectFolder]);
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

  it('/quit tears down a pending /login: its pty ends', async () => {
    fs.rmSync(path.join(authStateDir, 'logged-in'), { force: true });
    await topic.sendAndAwaitReply('/login', fakeLoginUrl);
    const loginPid = Number(fs.readFileSync(path.join(authStateDir, 'login.pid'), 'utf8'));
    assert.ok(checkIsProcessAlive(loginPid), 'the sign-in CLI is waiting for the code');

    fakeTelegram.pushOperatorMessage(topicThreadId, '/quit');
    await getCharness().waitFor('the sign-in CLI to end', stopTimeoutMs, () => !checkIsProcessAlive(loginPid));
  });
});
