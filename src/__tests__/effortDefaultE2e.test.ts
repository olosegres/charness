/**
 * @description The instance-wide default effort, at PROCESS level: the BUILT charness started the way an isolated
 * instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with the fake
 * `claude` recording how every session is launched (`--effort`). The test plays the operator in the General topic
 * and in two bound topics. One flow, in order:
 *
 *   boot → two topics bound to folders
 *   → `/effort` in General: the default of every topic without its own effort, ✓ on the code fallback (medium),
 *     nothing written until a tap; in a topic: the level and where it comes from, with «As in General»
 *   → a tap in General writes `settings.json` beside the env file, answers what that means, and the picker follows
 *   → a new session in a topic with no pick of its own launches with that level — and `/status` and the ready
 *     notice name it
 *   → a topic with its own pick keeps it when General changes; a running session is not restarted by the change
 *   → the next start of the topic without a pick uses the new default, and the pinned banner names it
 *   → «As in General» drops a topic's pick and re-spawns its live session at the default (same conversation)
 *   → a hand edit of `settings.json` applies to the next start with no restart; an invalid one is one named log
 *     error and the code fallback applies; a General tap over it replaces it
 *   → after a bot restart an adopted session still names the level it runs, and a re-spawn of it keeps its model
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is
 * stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { fakeClaudeLogFileNames, getFlagValues, getLaunchSessionId, type FakeClaudeTurn } from './jiraE2e/fakeClaudeContract';
import {
  builtCliPath,
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  isolatedBaselineSettings,
  IsolatedCharness,
  listTmuxSessions,
  readJsonLines,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const followerThreadId = 111;
const pickerThreadId = 112;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
/** The topic that never picks an effort (follows General) and the one that picks its own. */
const followerFolder = 'follower';
const pickerFolder = 'picker';
const launchLine = 'Launching Telegraf bot (long polling';
const pickerKeyString = `${group.id}:${pickerThreadId}`;

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
const agentStartTimeoutMs = 60 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let follower: TopicDriver;
let picker: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** The General picker message the flow taps on, and the topics' pickers. */
let generalPicker: FakeTelegramMessage;
/** The conversation (and process) the picker topic's session ran before «as in General». */
let pickerSessionId = '';
let pickerPidBeforeClear = 0;
let promptCounter = 0;

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

/** `settings.json` sits beside the instance's env file (the symlink-free case of the config location). */
function getSettingsFilePath(): string {
  return path.join(path.dirname(getLayout().envFile), 'settings.json');
}

function readSettingsFile(): { defaultEffort?: string; autoUpdate?: string } {
  return JSON.parse(fs.readFileSync(getSettingsFilePath(), 'utf8'));
}

/** A hand edit the way an editor saves it: a new file renamed over the old, so the bot's change stamp moves. */
function writeSettingsFileByHand(text: string): void {
  const tempPath = `${getSettingsFilePath()}.by-hand`;
  fs.writeFileSync(tempPath, text);
  fs.renameSync(tempPath, getSettingsFilePath());
}

/** The per-topic effort picks the Claude backends keep (`DATA_DIR/.claude-effort-prefs.json`). */
function readEffortPicks(): Record<string, string> {
  const picksPath = path.join(getLayout().dataDir, '.claude-effort-prefs.json');
  return fs.existsSync(picksPath) ? JSON.parse(fs.readFileSync(picksPath, 'utf8')) : {};
}

interface FakeLaunch {
  argv: string[];
  isSessionLaunch: boolean;
  pid: number;
}

function getSessionLaunches(): FakeLaunch[] {
  return readJsonLines<FakeLaunch>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.launches)).filter((launch) => launch.isSessionLaunch);
}

function getAgentTurns(label: string): FakeClaudeTurn[] {
  return readJsonLines<FakeClaudeTurn>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.turns)).filter((turn) => turn.issueKey === label);
}

/**
 * Send a labelled prompt in `driver`'s topic and read how the process that answered it was launched: the way to
 * tell WHICH launch belongs to a topic, since the fake records launches by pid.
 */
async function askAgentAndReadLaunch(threadId: number): Promise<{ pid: number; argv: string[] }> {
  promptCounter += 1;
  const label = `EFF-${promptCounter}`;
  fakeTelegram.pushOperatorMessage(threadId, `${label} [fake:answer] which effort am I running?`);
  await getCharness().waitFor(`the prompt ${label} to reach the agent`, agentStartTimeoutMs, () => getAgentTurns(label).length === 1);
  const [turn] = getAgentTurns(label);
  const launch = getSessionLaunches().filter((candidate) => candidate.pid === turn.pid).at(-1);
  assert.ok(launch, `a launch recorded for the process ${turn.pid} that answered ${label}`);
  return { pid: turn.pid, argv: launch.argv };
}

/** Start charness on the instance and wait for its first poll to reach the fake Bot API. */
async function startCharness(): Promise<void> {
  charness = new IsolatedCharness(getLayout());
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

/** A topic's session is stopped (`/quit`) and started again (`/claude`), so the NEXT start reads the settings. */
async function restartSession(driver: TopicDriver): Promise<void> {
  await driver.sendAndAwaitReply('/quit', 'stopped');
  await driver.sendAndAwaitReply('/claude', 'ready in');
}

describe('The instance default effort end to end: built charness, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-effort-', [followerFolder, pickerFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    follower = new TopicDriver(fakeTelegram, getCharness, followerThreadId, replyTimeoutMs);
    picker = new TopicDriver(fakeTelegram, getCharness, pickerThreadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
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

  it('boots Telegram-only against the fake Bot API and binds both topics to a folder', async () => {
    await startCharness();
    await follower.sendAndAwaitReply(`/bind ${followerFolder}`, `Bound to \`${followerFolder}\``);
    await picker.sendAndAwaitReply(`/bind ${pickerFolder}`, `Bound to \`${pickerFolder}\``);
  });

  it('/effort in General says it is the default of every topic without its own effort, offers the Claude levels with ✓ on medium, and writes nothing until a tap', async () => {
    generalPicker = await general.sendAndAwaitReply('/effort', 'Default effort for all topics: medium');
    assert.match(generalPicker.text, /Every topic that has no effort of its own runs at this level; topics with their own effort keep it\./);
    assert.deepEqual(general.getKeyboardData(generalPicker), [
      ['effort_low', 'effort_medium', 'effort_high'],
      ['effort_xhigh', 'effort_max', 'effort_auto'],
      ['effort_ultracode'],
    ]);
    assert.deepEqual(general.getKeyboardLabels(generalPicker).flat().filter((label) => label.includes('✓')), ['medium ✓']);
    assert.deepEqual(readSettingsFile(), isolatedBaselineSettings, 'viewing the default changes nothing: the file is still the one the harness wrote');
  });

  it('/effort in a topic names the level and where it comes from, and offers «As in General» with the value it would give', async () => {
    const screen = await follower.sendAndAwaitReply('/effort', 'Effort in this topic: medium — as in General');
    assert.deepEqual(follower.getKeyboardData(screen).at(-1), ['effortsame']);
    assert.deepEqual(follower.getKeyboardLabels(screen).at(-1), ['As in General (medium)']);
    assert.ok(follower.getKeyboardLabels(screen).flat().includes('medium ✓'));
  });

  it('a tap in General writes settings.json beside the env file, answers what it means, and the picker follows', async () => {
    const answer = await general.tapAndAwaitAnswer(generalPicker, 'effort_high');
    assert.equal(answer, 'Effort: high');
    assert.deepEqual(readSettingsFile(), { ...isolatedBaselineSettings, defaultEffort: 'high' }, 'the tap keeps the other fields of the file');
    const confirmation = await general.waitForMessage('the confirmation', (message) => message.text.startsWith('✅ Default effort for all topics: high'));
    assert.match(confirmation.text, /Topics with their own effort keep it\. It applies from each topic's next session start or wake-up — running sessions are not restarted\./);
    await general.waitForMessageText('the picker re-rendered', generalPicker, (text) => text.startsWith('⚙️ Default effort for all topics: high'));
    assert.ok(general.getKeyboardLabels(generalPicker).flat().includes('high ✓'));
    assert.ok(!general.getKeyboardLabels(generalPicker).flat().includes('medium ✓'));
  });

  it('a new session in a topic without its own pick launches with the General default; the ready notice and /status name it', async () => {
    const ready = await follower.sendAndAwaitReply('/claude', 'ready in');
    assert.match(ready.text, /⚙️ Effort: high/);
    const { argv } = await askAgentAndReadLaunch(followerThreadId);
    assert.deepEqual(getFlagValues(argv, '--effort'), ['high'], `--effort in ${argv.join(' ')}`);

    await follower.sendAndAwaitReply('/status', 'Effort: high');
  });

  it('a topic with its own pick launches with it, and keeps it while General changes; the running session of the other topic is not restarted', async () => {
    const screen = await picker.sendAndAwaitReply('/effort', 'Effort in this topic: high — as in General');
    const pickAnswer = await picker.tapAndAwaitAnswer(screen, 'effort_max');
    assert.match(pickAnswer, /Level saved/, 'no agent yet: stored for the next start');
    await picker.waitForMessageText('the picker shows the pick as its own', screen, (text) => text === '⚙️ Effort in this topic: max — set for this topic');
    assert.equal(readEffortPicks()[pickerKeyString], 'max');

    await picker.sendAndAwaitReply('/claude', 'ready in');
    const launched = await askAgentAndReadLaunch(pickerThreadId);
    assert.deepEqual(getFlagValues(launched.argv, '--effort'), ['max'], 'the topic\'s own pick wins over the General default');
    pickerSessionId = getLaunchSessionId(launched.argv) ?? '';
    pickerPidBeforeClear = launched.pid;
    assert.ok(pickerSessionId);

    const launchesBefore = getSessionLaunches().length;
    await general.tapAndAwaitAnswer(generalPicker, 'effort_low');
    assert.deepEqual(readSettingsFile(), { ...isolatedBaselineSettings, defaultEffort: 'low' });
    await general.waitForMessageText('the picker follows', generalPicker, (text) => text.startsWith('⚙️ Default effort for all topics: low'));
    await picker.sendAndAwaitReply('/effort', 'Effort in this topic: max — set for this topic');
    // The follower's process was started on high: that is what it runs, and the screens say so — with the level the
    // next start will take. (Showing «low — as in General» here would name a level nothing runs at.)
    await follower.sendAndAwaitReply('/effort', 'Effort in this topic: high (low from the next start) — as in General');
    await follower.sendAndAwaitReply('/status', 'Effort: high (low from the next start)');
    assert.equal(getSessionLaunches().length, launchesBefore, 'a change of the default restarts no running session');
  });

  it('the follower\'s NEXT start uses the new default, and the pinned banner names it', async () => {
    await restartSession(follower);
    const { argv } = await askAgentAndReadLaunch(followerThreadId);
    assert.deepEqual(getFlagValues(argv, '--effort'), ['low'], `--effort in ${argv.join(' ')}`);
    // The banner is refreshed by the session's lifecycle events; the restart is one, and the agent is known by now.
    const banner = await follower.waitForMessage('the pinned banner with the resolved effort', (message) => message.text.startsWith(`📁 ${followerFolder} · Claude Code`) && message.text.includes('⚙️ low'));
    assert.match(banner.text, /^📁 follower · Claude Code \(stream\) · ⚙️ low · /);
    await follower.sendAndAwaitReply('/effort', 'Effort in this topic: low — as in General');
  });

  it('«As in General» drops the topic\'s pick, and its live session is re-spawned at the default — the same conversation', async () => {
    const screen = await picker.sendAndAwaitReply('/effort', 'Effort in this topic: max — set for this topic');
    assert.deepEqual(picker.getKeyboardLabels(screen).at(-1), ['As in General (low)']);

    const answer = await picker.tapAndAwaitAnswer(screen, 'effortsame');
    assert.equal(answer, 'As in General: low');
    await picker.waitForMessage('the confirmation', (message) => message.text === '✅ Effort in this topic follows General again: low');
    await picker.waitForMessageText('the picker re-rendered', screen, (text) => text === '⚙️ Effort in this topic: low — as in General');
    assert.equal(readEffortPicks()[pickerKeyString], undefined, 'the pick is gone from disk, not only from the screen');

    const respawned = await askAgentAndReadLaunch(pickerThreadId);
    assert.notEqual(respawned.pid, pickerPidBeforeClear, 'the live process was replaced');
    assert.deepEqual(getFlagValues(respawned.argv, '--effort'), ['low']);
    assert.deepEqual(getFlagValues(respawned.argv, '--resume'), [pickerSessionId], 'the same conversation, resumed');
  });

  it('a hand edit of settings.json applies to the next start with no restart', async () => {
    const restartsBefore = getCharness().output.split(launchLine).length;
    writeSettingsFileByHand('{ "defaultEffort": "xhigh" }\n');
    await restartSession(follower);
    const { argv } = await askAgentAndReadLaunch(followerThreadId);
    assert.deepEqual(getFlagValues(argv, '--effort'), ['xhigh'], `--effort in ${argv.join(' ')}`);
    assert.equal(getCharness().output.split(launchLine).length, restartsBefore, 'the bot was not restarted');
  });

  it('an invalid hand edit is ONE named log error and the code fallback (medium) applies; a General tap over it replaces it', async () => {
    const reportMarker = '[Settings] settings.json defaultEffort';
    const reportsBefore = getCharness().output.split(reportMarker).length - 1;
    writeSettingsFileByHand('{ "defaultEffort": "mid" }\n');
    await restartSession(follower);
    const { argv } = await askAgentAndReadLaunch(followerThreadId);
    assert.deepEqual(getFlagValues(argv, '--effort'), ['medium'], `--effort in ${argv.join(' ')}`);
    await follower.sendAndAwaitReply('/status', 'Effort: medium');
    assert.equal(getCharness().output.split(reportMarker).length - 1, reportsBefore + 1, 'one named error for the broken file, not one per read');

    await general.tapAndAwaitAnswer(generalPicker, 'effort_high');
    assert.deepEqual(readSettingsFile(), { defaultEffort: 'high' }, 'the tapped button is the fix');
    await restartSession(follower);
    const fixed = await askAgentAndReadLaunch(followerThreadId);
    assert.deepEqual(getFlagValues(fixed.argv, '--effort'), ['high']);
  });

  it('a bot restart (every hot reload is one) keeps naming the level the surviving session really runs, with the next start\'s level beside it', async () => {
    // The follower runs high (started after the last General tap); General moves on to low while it runs.
    await general.tapAndAwaitAnswer(generalPicker, 'effort_low');
    assert.deepEqual(readSettingsFile(), { defaultEffort: 'low' });

    await getCharness().stop();
    await startCharness();
    await getCharness().waitFor('the surviving sessions to be re-adopted', replyTimeoutMs, () => /\[reattach\] claude-json-stream: adopted [1-9]/.test(getCharness().output));

    // The adopted process knows nothing but its own command line: the level comes from there.
    await follower.sendAndAwaitReply('/status', 'Effort: high (low from the next start)');
    await follower.sendAndAwaitReply('/effort', 'Effort in this topic: high (low from the next start) — as in General');
  });

  it('an effort pick on a session adopted after a bot restart re-spawns it with the model it ran, not without one', async () => {
    await picker.sendAndAwaitReply('/model sonnet', 'Model set to');
    const picked = await askAgentAndReadLaunch(pickerThreadId);
    assert.deepEqual(getFlagValues(picked.argv, '--model'), ['sonnet']);

    await getCharness().stop();
    await startCharness();
    await getCharness().waitFor('the surviving sessions to be re-adopted', replyTimeoutMs, () => /\[reattach\] claude-json-stream: adopted [1-9]/.test(getCharness().output));

    const screen = await picker.sendAndAwaitReply('/effort', 'Effort in this topic:');
    await picker.tapAndAwaitAnswer(screen, 'effort_max');
    const respawned = await askAgentAndReadLaunch(pickerThreadId);
    assert.notEqual(respawned.pid, picked.pid, 'the adopted process was replaced');
    assert.deepEqual(getFlagValues(respawned.argv, '--effort'), ['max']);
    assert.deepEqual(getFlagValues(respawned.argv, '--model'), ['sonnet'], 'the model the adopted process ran rides the re-spawn');
  });

  it('a pick while no agent runs is stored and answered with the notice whole, and the pinned banner follows it — tapped or typed', async () => {
    await picker.sendAndAwaitReply('/quit', 'stopped');
    // The banner of a stopped topic still names the topic's effort (its own pick, max, from the last step).
    const banner = await picker.waitForMessage('the banner of the stopped topic', (message) => message.text.startsWith(`📁 ${pickerFolder} · Claude Code`) && message.text.includes('⚙️ max') && message.text.endsWith('⚪ idle'));

    const screen = await picker.sendAndAwaitReply('/effort', 'Effort in this topic: max — set for this topic');
    const toast = await picker.tapAndAwaitAnswer(screen, 'effort_xhigh');
    assert.equal(toast, 'ℹ️ Level saved. No agent running — it will apply on next start.', 'the notice reaches the user whole, not cut and not as an error');
    await picker.waitForMessageText('the picker shows the stored pick', screen, (text) => text === '⚙️ Effort in this topic: xhigh — set for this topic');
    await picker.waitForMessageText('the banner follows the tapped pick', banner, (text) => text.includes('⚙️ xhigh') && !text.includes('⚙️ max'));
    assert.equal(readEffortPicks()[pickerKeyString], 'xhigh');

    await picker.sendAndAwaitReply('/effort high', 'No agent running');
    await picker.waitForMessageText('the banner follows the typed pick', banner, (text) => text.includes('⚙️ high') && !text.includes('⚙️ xhigh'));
    assert.equal(readEffortPicks()[pickerKeyString], 'high');
  });
});
