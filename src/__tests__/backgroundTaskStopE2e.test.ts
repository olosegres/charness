/**
 * @description The agent's OWN pending work and the automatic stops, at PROCESS level: the BUILT charness started the
 * way an isolated instance is (`scripts/run-isolated.sh`) against the fake Bot API of `telegramE2e/fakeTelegram.ts`,
 * with the fake `claude` (`jiraE2e/fakeClaude.ts`, mode `background-notify`) leaving a background task running after
 * its answer and ending it the way the real CLI 2.1.310 was measured to: the task's end, the empty background list,
 * then the task's own turn, whose first output comes only after the API round-trip (8 s here). The idle window and
 * the pending-work hold are cut to seconds (`AGENT_IDLE_MINUTES`, `CHARNESS_TEST_TIMINGS` `backgroundHoldMaxMs`). One flow, in order:
 *
 *   boot → the topic is bound → `/claude` → BG-1 answered; its background task runs
 *   → the bot restarts after an upgrade that changed its tools: the adopted process runs a stale tool list, and is
 *     NOT stopped early — the task ends, the task's own turn reaches the topic from the SAME process (the incident: the
 *     stop landed in the gap before that turn's first output and the result was lost) — then the normal idle
 *     lifecycle: the idle compaction first, the stop after it
 *   → BG-7's task ends with only its notification saying a turn is coming (no running event) and the turn starting
 *     after an idle window: the idle fire lands in that gap, keeps the process, and the turn reaches the topic
 *   → BG-2 leaves a task that never reports: the idle fire keeps the process while the hold lasts and looks again,
 *     and once the hold is spent the process is compacted and stopped — a forgotten task does not pin it forever; the
 *     topic gets ONE line naming the task, and the agent is not woken for it
 *   → the next message (BG-3) carries the note about the lost task to the agent, once
 *   → BG-3's process is killed while its task runs (a crash): one line in the topic, and the conversation is resumed
 *     at once with a note naming the lost task — the agent is not left waiting for a notification that never comes
 *   → BG-4's process is killed too, right after that resume: no second resume (no restart loop) — the line says the
 *     next message tells it, and the next message (BG-5) carries the note
 *   → BG-6's process is gone when the bot comes back (killed while the bot was down): one line, and the conversation
 *     is resumed with the note
 *   → a usage limit moves the topic to a second account while BG-8's task runs: the switch notice says the background
 *     work stopped, no separate line or resume, and the continue prompt of the new process carries the note
 *   → `/effort` re-spawns the process while BG-9's task runs: one line, and the conversation is resumed in the new
 *     process with the note — no "session ended"
 *   → `/claude_mode` moves the topic to another Claude backend while BG-10's task runs: the switch reply says the
 *     background work stopped, no separate line, and the next message (BG-11) carries the note
 *   → `/claude_mode` while only BG-12's turn runs and BG-13 waits to be taken in (no task, no job): the reply says
 *     nothing about background work — the line follows what the note lists — and the note names the cut-off turn
 *   → `/claude_mode` while BG-15's task runs and the bound folder is gone: the folder error still says the background
 *     work stopped
 *
 * Nothing leaves the machine: the Bot API is on loopback and the agent is a fake. Everything the test starts is stopped
 * in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import {
  fakeClaudeBackgroundGapMsFileName,
  fakeClaudeBackgroundReleaseFileName,
  fakeClaudeLogFileNames,
  fakeNotificationTurnLatencyMs,
  getFakeBackgroundTaskDescription,
  getFakeBackgroundTaskFinishedText,
  getFlagValues,
  getLaunchSessionId,
  type FakeClaudePrompt,
  type FakeClaudeTurn,
} from './jiraE2e/fakeClaudeContract';
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
import { computeResetsAtIso, getAccountConfigDir, getAgentTurns, getSessionLaunches, readPersistedState, restartCharnessWithState, startCharnessOnInstance } from './e2e/fallbackFlowKit';
import { createClaudeProfileLayout } from '../utils/claudeProfiles';
import { enDict } from '../i18n/en';
import { checkIsPidAlive } from '../utils/jsonStreamHost';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';
import { claudeJsonStreamUsageLogPrefix } from '../adapters/claudeJsonStreamAdapter';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const topicThreadId = 111;
const topicKey = `${group.id}:${topicThreadId}`;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const projectFolder = 'background-work';

/** The idle window, cut to seconds. */
const idleWindowMinutes = '0.2';
const idleWindowMs = 12 * 1000;
/** The pending-work hold, cut to a minute: long enough for the restart and the release, short enough to wait out. */
const backgroundHoldMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
/** The gap between a task's end and its turn's start in the slow step: past one idle window, so the idle fire lands in it. */
const backgroundTurnGapMs = idleWindowMs + 3 * 1000;
/** The account the limit step moves the topic to, and when its limit resets. */
const takeoverAccount = 'work';
const resetsAtIso = computeResetsAtIso(1);
/** The idle compaction and stop after the task's turn: one idle window plus the compaction turn and the teardown. */
const idleStopTimeoutMs = idleWindowMs + 30 * 1000;
/** The stop after a spent hold: the hold, the idle fires that look again, then the compaction and the teardown. */
const holdStopTimeoutMs = backgroundHoldMs + idleWindowMs + 30 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let topic: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
/** The conversation the topic's agent runs. */
let sessionId = '';

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

/** The process the turn labelled `label` ran in (its first turn). */
function getTurnPid(label: string): number {
  const [turn] = getAgentTurns(getLayout(), label);
  if (!turn) throw new Error(`no turn of ${label} recorded`);
  return turn.pid;
}

function listTaskTurns(): Array<FakeClaudeTurn & { origin?: string }> {
  return readJsonLines<FakeClaudeTurn & { origin?: string }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.turns)).filter((turn) => turn.origin === 'task-notification');
}

function listCompactions(): Array<{ sessionId: string; pid: number }> {
  return readJsonLines<{ sessionId: string; pid: number }>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.compactions));
}

/** Where in the bot's output `text` first appears after `fromIndex`; -1 when it does not. */
function findOutput(text: string, fromIndex: number): number {
  return getCharness().output.indexOf(text, fromIndex);
}

const stopLine = `[compact-on-idle] ${topicKey} process stopped; the session sleeps`;
/** The first line of the note the agent gets about lost work (`utils/lostWork.ts`). */
const lostWorkNoteStart = '[charness] This conversation\'s agent process ended while its own work was still pending';
/** The end of the topic line when the bot resumed the agent at once, and when the next message will. */
const resumedLineEnd = 'I resumed it and asked it to check that work again.';
const heldLineEnd = 'Your next message resumes it and tells it what was lost.';

function listPrompts(): FakeClaudePrompt[] {
  return readJsonLines<FakeClaudePrompt>(path.join(getLayout().fakeLogDir, fakeClaudeLogFileNames.prompts));
}

/** The lost-work note prompts the agents got, oldest first. */
function listLostWorkNotes(): FakeClaudePrompt[] {
  return listPrompts().filter((prompt) => prompt.text.includes(lostWorkNoteStart));
}

/** The topic's lost-work lines that name the task of the turn labelled `label`. */
function listLostWorkLines(label: string): string[] {
  const taskName = `«${getFakeBackgroundTaskDescription(label)}»`;
  return topic.listMessages().map((message) => message.text).filter((text) => text.startsWith('⚠️ The agent\'s process') && text.includes(taskName));
}

/** How many turns ended so far (the bot logs every result's usage). */
function countTurnEnds(): number {
  return getCharness().output.split(`${claudeJsonStreamUsageLogPrefix}${topicKey}:`).length - 1;
}

/**
 * Send a labelled message; wait for its answer AND its turn's end — the answer shows a moment before the turn ends (the
 * answer tool's round-trip). The fake runs one turn at a time, so the first end after the answer shows is this turn's:
 * an end counted from before the send could be an earlier turn's (a note queued ahead of it).
 */
async function sendAndAwaitTurnEnd(label: string, text: string): Promise<void> {
  fakeTelegram.pushOperatorMessage(topicThreadId, `${label} ${text}`);
  await topic.waitForMessage(`the answer to ${label}`, (message) => message.text.includes(`Fake final answer for ${label}`));
  const turnEndsAtAnswer = countTurnEnds();
  await getCharness().waitFor(`the end of ${label}'s turn`, replyTimeoutMs, () => countTurnEnds() > turnEndsAtAnswer);
}

/**
 * Send a labelled `background-notify` message and wait until the bot has seen the task it left running — its persisted
 * tail record lists it (the turn-end count cannot tell this turn from a queued one before it: the answer arrives over
 * the answer tool, ahead of the bot's read of the earlier turn's end). Returns the process's pid.
 */
async function startBackgroundTask(label: string): Promise<number> {
  fakeTelegram.pushOperatorMessage(topicThreadId, `${label} [fake:background-notify] start a watcher`);
  await topic.waitForMessage(`the answer to ${label}`, (message) => message.text.includes(`Fake final answer for ${label}`));
  const description = getFakeBackgroundTaskDescription(label);
  await getCharness().waitFor(`the bot to see ${label}'s task`, replyTimeoutMs, () =>
    readPersistedState(getLayout()).agents?.[topicKey]?.jsonStreamTail?.backgroundTasks?.some((task) => task.description === description) === true);
  return getTurnPid(label);
}

describe('The agent\'s own background work is never cut off by an automatic stop: built charness, fake Bot API, fake claude', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-bgtask-', [projectFolder], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fs.mkdirSync(layout.fakeStateDir, { recursive: true });
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
      CLAUDE_BIN: writeFakeClaudeLauncher(layout, null),
      AGENT_IDLE_MINUTES: idleWindowMinutes,
      ...getTelegramFlowTestTimingsEnv({ backgroundHoldMaxMs: backgroundHoldMs }),
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

  it('boots, binds the topic, and the agent answers BG-1 and leaves a background task running', async () => {
    charness = await startCharnessOnInstance(getLayout(), fakeTelegram);
    await topic.sendAndAwaitReply(`/bind ${projectFolder}`, `Bound to \`${projectFolder}\``);
    await topic.sendAndAwaitReply('/verbosity stream_answers', 'This topic shows: Stream + answers');
    await topic.sendAndAwaitReply('/claude', 'ready in');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'BG-1 [fake:background-notify] watch the run');
    await topic.waitForMessage('the answer to BG-1', (message) => message.text.includes('Fake final answer for BG-1'));
    // The turn ends a moment after its answer shows (the answer tool's round-trip): a restart before that cuts the turn.
    await getCharness().waitFor('the end of BG-1\'s turn', replyTimeoutMs, () => findOutput(`${claudeJsonStreamUsageLogPrefix}${topicKey}:`, 0) >= 0);
    const launch = getSessionLaunches(getLayout()).at(-1);
    sessionId = (launch && getLaunchSessionId(launch.argv)) ?? '';
    assert.ok(sessionId, 'the launch carries a conversation id');
    assert.ok(checkIsPidAlive(getTurnPid('BG-1')), 'the process holding the task is alive');
  });

  it('adopted with a stale tool list, the process is not stopped early: the task\'s own turn reaches the topic, then the idle compaction, then the stop', async () => {
    const pid = getTurnPid('BG-1');
    const outputBeforeRestart = getCharness().output.length;
    // An upgrade that changed the bot's tools: the digest the live process was started with no longer matches.
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      const agent = persisted.agents?.[topicKey];
      assert.ok(agent?.mcpToolDigest, 'the topic has a persisted tool digest to make stale');
      agent.mcpToolDigest = 'a-digest-of-an-earlier-build';
    });
    await getCharness().waitFor('the adopt of the stale process', replyTimeoutMs, () => findOutput(`[reattach] ${topicKey}: adopted with a stale tool list`, 0) >= 0);
    assert.ok(checkIsPidAlive(pid), 'the adopted process is alive');

    // The task ends: the background list empties, and the task's turn shows its first output only after the round-trip.
    const outputBeforeRelease = getCharness().output.length;
    fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeBackgroundReleaseFileName), '');
    const finishedText = getFakeBackgroundTaskFinishedText('BG-1');
    await topic.waitForMessage('the task\'s own turn in the topic', (message) => message.text.includes(finishedText));
    assert.deepEqual(listTaskTurns().map((turn) => turn.pid), [pid], 'the task\'s turn ran in the adopted process, to its end');
    assert.ok(getCharness().output.slice(outputBeforeRelease).indexOf(stopLine) < 0, `no stop in the ${fakeNotificationTurnLatencyMs} ms before the task's turn showed`);
    assert.ok(!getCharness().output.slice(outputBeforeRestart).includes('stopping the adopted process'), 'no early stop of the adopted process');

    // The normal idle lifecycle: compacted in the same process first, stopped after.
    await getCharness().waitFor('the idle compaction of the adopted process', idleStopTimeoutMs, () => listCompactions().some((compaction) => compaction.sessionId === sessionId && compaction.pid === pid));
    await getCharness().waitFor('the idle stop after the compaction', idleStopTimeoutMs, () => findOutput(stopLine, outputBeforeRelease) >= 0);
    assert.ok(!checkIsPidAlive(pid), 'the process is gone');
  });

  it('a task whose own turn starts only after an idle window (no running event, only its notification): the idle fire keeps the process and the turn reaches the topic', async () => {
    const pid = await startBackgroundTask('BG-7');
    const gapPath = path.join(getLayout().fakeStateDir, fakeClaudeBackgroundGapMsFileName);
    fs.writeFileSync(gapPath, backgroundTurnGapMs.toString());
    try {
      // Released right after the turn ended: the idle fire, one window after that end, lands inside the gap.
      const outputBeforeRelease = getCharness().output.length;
      fs.writeFileSync(path.join(getLayout().fakeStateDir, fakeClaudeBackgroundReleaseFileName), '');
      // The turn starts after the gap and shows its output after the round-trip: wait for both.
      await getCharness().waitFor('the slow task turn in the topic', backgroundTurnGapMs + fakeNotificationTurnLatencyMs + replyTimeoutMs, () =>
        topic.listMessages().some((message) => message.text.includes(getFakeBackgroundTaskFinishedText('BG-7'))));
      const sinceRelease = getCharness().output.slice(outputBeforeRelease);
      assert.ok(sinceRelease.includes(`[compact-on-idle] ${topicKey} process kept: working`), `the idle fire landed in the gap and kept the process:\n${sinceRelease}`);
      assert.ok(!sinceRelease.includes('stopping the idle process'), 'never stopped in the gap');
      assert.deepEqual(listTaskTurns().filter((turn) => turn.issueKey === 'BG-7').map((turn) => turn.pid), [pid], 'the task\'s turn ran in the same process, to its end');
      await getCharness().waitFor('the idle stop after the task turn', idleStopTimeoutMs, () => findOutput(stopLine, outputBeforeRelease) >= 0);
    } finally {
      fs.rmSync(gapPath, { force: true });
    }
  });

  it('a task that never reports holds the process only for the hold: the idle fire keeps it and looks again, then the process is compacted and stopped', async () => {
    const outputBefore = getCharness().output.length;
    const compactionsBefore = listCompactions().length;
    fakeTelegram.pushOperatorMessage(topicThreadId, 'BG-2 [fake:background-notify] start a watcher and forget it');
    await topic.waitForMessage('the answer to BG-2', (message) => message.text.includes('Fake final answer for BG-2'));
    const answeredAt = Date.now();
    const pid = getTurnPid('BG-2');

    await getCharness().waitFor('the idle fire to keep the process for its task', idleStopTimeoutMs, () => findOutput(`[compact-on-idle] ${topicKey} process kept: working`, outputBefore) >= 0);
    await getCharness().waitFor('the idle fire to look again', replyTimeoutMs, () => findOutput(`[compact-on-idle] ${topicKey} looks again in`, outputBefore) >= 0);
    assert.ok(checkIsPidAlive(pid), 'kept while the hold lasts');

    await getCharness().waitFor('the stop once the hold is spent', holdStopTimeoutMs, () => findOutput(stopLine, outputBefore) >= 0);
    assert.ok(Date.now() - answeredAt >= backgroundHoldMs, 'not stopped before the hold was spent');
    assert.ok(listCompactions().length > compactionsBefore, 'compacted before the stop');
    assert.ok(!checkIsPidAlive(pid), 'the process is gone');
    // The task went with the process: one line, and the agent is not woken for a task nobody heard from.
    await topic.waitForMessage('the line about the task the stop let go', (message) => listLostWorkLines('BG-2').includes(message.text));
    const [line] = listLostWorkLines('BG-2');
    assert.ok(line.includes('had no turn for') && line.endsWith(heldLineEnd), line);
    assert.equal(listLostWorkNotes().length, 0, 'no resume for a spent hold');
  });

  it('the next message carries the note about the task the hold let go, once', async () => {
    const promptsBefore = listPrompts().length;
    await startBackgroundTask('BG-3');
    const [bg3Prompt] = listPrompts().slice(promptsBefore).filter((prompt) => prompt.text.includes('BG-3 [fake:background-notify]'));
    assert.ok(bg3Prompt, 'BG-3 reached the agent');
    assert.ok(bg3Prompt.text.startsWith(lostWorkNoteStart), `the note leads the prompt:\n${bg3Prompt.text}`);
    assert.ok(bg3Prompt.text.includes(`«${getFakeBackgroundTaskDescription('BG-2')}»`) && bg3Prompt.text.includes('after a long time without a turn'), bg3Prompt.text);
    assert.equal(listLostWorkNotes().length, 1, 'told once');
  });

  it('a process killed while its task runs: one line, and the conversation is resumed at once with the note', async () => {
    const pid = getTurnPid('BG-3');
    const launchesBefore = getSessionLaunches(getLayout()).length;
    process.kill(pid, 'SIGKILL');
    await topic.waitForMessage('the line about the task the crash took', (message) => listLostWorkLines('BG-3').includes(message.text));
    const [line] = listLostWorkLines('BG-3');
    assert.ok(line.includes('ended unexpectedly') && line.endsWith(resumedLineEnd), line);
    assert.ok(!topic.listMessages().some((message) => message.text.includes('session ended')), 'the line replaces the bare "session ended"');
    await getCharness().waitFor('the note to reach the resumed agent', replyTimeoutMs, () => listLostWorkNotes().some((prompt) => prompt.text.includes(`«${getFakeBackgroundTaskDescription('BG-3')}»`)));
    const note = listLostWorkNotes().at(-1);
    assert.ok(note?.text.includes('(it exited unexpectedly)'), note?.text);
    const resumed = getSessionLaunches(getLayout()).slice(launchesBefore);
    assert.equal(resumed.length, 1, 'resumed once');
    assert.equal(resumed[0].pid, note?.pid, 'the note went to the resumed process');
    assert.equal(getLaunchSessionId(resumed[0].argv), sessionId, 'the same conversation');
  });

  it('a second crash right after that resume is not resumed again: the next message carries the note', async () => {
    const pid = await startBackgroundTask('BG-4');
    const notesBefore = listLostWorkNotes().length;
    process.kill(pid, 'SIGKILL');
    await topic.waitForMessage('the line about the task the second crash took', (message) => listLostWorkLines('BG-4').includes(message.text));
    assert.ok(listLostWorkLines('BG-4')[0].endsWith(heldLineEnd), listLostWorkLines('BG-4')[0]);
    assert.ok(getCharness().output.includes(`[lost-work] ${topicKey}: the process ended (exited) with the agent's own work pending (1 background task(s), 0 scheduled job(s)); the note rides the next prompt`));
    await sendAndAwaitTurnEnd('BG-5', '[fake:answer] are you back');
    const notes = listLostWorkNotes().slice(notesBefore);
    assert.equal(notes.length, 1, 'one note, with the next message');
    assert.ok(notes[0].text.includes('BG-5 [fake:answer]') && notes[0].text.includes(`«${getFakeBackgroundTaskDescription('BG-4')}»`), notes[0].text);
  });

  it('a process gone when the bot comes back: one line, and the conversation is resumed with the note', async () => {
    const pid = await startBackgroundTask('BG-6');
    const notesBefore = listLostWorkNotes().length;
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      process.kill(pid, 'SIGKILL'); // a host reboot or a killed tmux server, while the bot is down
      // The loop guard survives a restart (BG-3's resume is still inside its 10 minutes); a fresh episode clears it here.
      assert.equal(typeof persisted.lostWorkResumedAt?.[topicKey], 'number', 'the last automatic resume is persisted');
      delete persisted.lostWorkResumedAt;
    });
    await topic.waitForMessage('the line about the task found gone', (message) => listLostWorkLines('BG-6').includes(message.text));
    const [line] = listLostWorkLines('BG-6');
    assert.ok(line.includes('was gone after the restart') && line.endsWith(resumedLineEnd), line);
    await getCharness().waitFor('the note to reach the resumed agent', replyTimeoutMs, () => listLostWorkNotes().length > notesBefore);
    const note = listLostWorkNotes().at(-1);
    assert.ok(note?.text.includes('(it was gone when the bot came back after a restart)') && note.text.includes(`«${getFakeBackgroundTaskDescription('BG-6')}»`), note?.text);
  });

  it('a usage limit that moves the topic to another account while a task runs: one switch notice, no separate line or resume — the continue prompt tells the agent', async () => {
    createClaudeProfileLayout({ dataDir: getLayout().dataDir, name: takeoverAccount, homeClaudeDir: path.join(getLayout().instanceHome, '.claude') });
    charness = await restartCharnessWithState(getLayout(), fakeTelegram, getCharness(), (persisted) => {
      persisted.claudeProfiles = { ...persisted.claudeProfiles, [takeoverAccount]: { createdAt: new Date().toISOString(), loggedIn: true, email: 'work@example.com', subscriptionType: 'max' } };
      persisted.fallbackChain = [{ backend: 'claude', profile: takeoverAccount, model: null }];
      // The switch the limit makes by itself (off: it would only offer a button).
      persisted.claudeAutoSwitchOnLimitEnabled = true;
      // A fresh episode for the steps after this one: BG-6's resume no longer holds the loop guard.
      delete persisted.lostWorkResumedAt;
    });
    await startBackgroundTask('BG-8');
    const notesBefore = listLostWorkNotes().length;
    const launchesBefore = getSessionLaunches(getLayout()).length;
    fakeTelegram.pushOperatorMessage(topicThreadId, `LIM-1 [fake:usage-limit-once] [limit-resets:${resetsAtIso}] please carry on`);
    const notice = await topic.waitForMessage('the switch notice', (message) => message.text.startsWith('🔁'));
    assert.ok(notice.text.includes(enDict['fallback.backgroundStopped']), `the notice says the background work was stopped:\n${notice.text}`);
    await getCharness().waitFor('the conversation to go on under the second account', replyTimeoutMs, () => getAgentTurns(getLayout(), 'LIM-1').length === 2);
    const takeover = getSessionLaunches(getLayout()).slice(launchesBefore);
    assert.equal(takeover.length, 1, 'one re-spawn');
    assert.equal(takeover[0].claudeConfigDir, getAccountConfigDir(getLayout(), takeoverAccount));
    const notes = listLostWorkNotes().slice(notesBefore);
    assert.equal(notes.length, 1, 'told once');
    assert.equal(notes[0].pid, takeover[0].pid, 'by the new process\'s first prompt');
    assert.ok(notes[0].text.includes(`«${getFakeBackgroundTaskDescription('BG-8')}»`) && notes[0].text.includes('(the bot restarted it for a model, effort or account change)'), notes[0].text);
    assert.ok(notes[0].text.slice(notes[0].text.indexOf('\n\n')).trim().length > 0, 'the note leads the continue prompt, it is not a prompt of its own');
    assert.deepEqual(listLostWorkLines('BG-8'), [], 'no lost-work line beside the switch notice');
    // Decided at the call site, not by timing: the switch folded the loss; the re-spawn's own lost-work path never ran.
    assert.ok(getCharness().output.includes(`[lost-work] ${topicKey}: the agent's own work ended with the process (restarted); the move's first prompt tells the agent`), 'folded by the switch');
    assert.ok(!getCharness().output.includes(`[lost-work] ${topicKey}: the process ended (restarted)`), 'no separate note or line for the re-spawn');
  });

  it('`/effort` re-spawns the process while a task runs: one line, the conversation resumed with the note in the new process, no "session ended"', async () => {
    const pid = await startBackgroundTask('BG-9');
    const notesBefore = listLostWorkNotes().length;
    const launchesBefore = getSessionLaunches(getLayout()).length;
    const messagesBefore = topic.listMessages().length;
    const picker = await topic.sendAndAwaitReply('/effort', 'Effort in this topic');
    await topic.tapAndAwaitAnswer(picker, 'effort_high');
    await topic.waitForMessage('the line about the task the re-spawn took', (message) => listLostWorkLines('BG-9').includes(message.text));
    const [line] = listLostWorkLines('BG-9');
    assert.ok(line.includes('was restarted for the model, effort or account change') && line.endsWith(resumedLineEnd), line);
    const respawned = getSessionLaunches(getLayout()).slice(launchesBefore);
    assert.equal(respawned.length, 1, 're-spawned once');
    assert.deepEqual(getFlagValues(respawned[0].argv, '--effort'), ['high'], 'with the picked level');
    await getCharness().waitFor('the note to reach the re-spawned agent', replyTimeoutMs, () => listLostWorkNotes().length > notesBefore);
    const notes = listLostWorkNotes().slice(notesBefore);
    assert.equal(notes.length, 1, 'told once');
    assert.equal(notes[0].pid, respawned[0].pid, 'by the new process');
    assert.ok(notes[0].text.includes(`«${getFakeBackgroundTaskDescription('BG-9')}»`) && notes[0].text.includes('(the bot restarted it for a model, effort or account change)'), notes[0].text);
    assert.ok(!topic.listMessages().slice(messagesBefore).some((message) => message.text.includes('session ended')), 'a re-spawn is not an ended session');
    assert.ok(!checkIsPidAlive(pid), 'the old process is gone');
  });

  it('`/claude_mode` moves the topic to another backend while a task runs: the reply says the work stopped, no separate line, the next message tells the agent', async () => {
    const pid = await startBackgroundTask('BG-10');
    const notesBefore = listLostWorkNotes().length;
    const reply = await topic.sendAndAwaitReply('/claude_mode perturn', 'same conversation resumed');
    assert.ok(reply.text.includes(enDict['fallback.backgroundStopped']), `the switch reply says the background work was stopped:\n${reply.text}`);
    await sendAndAwaitTurnEnd('BG-11', '[fake:answer] still there');
    const notes = listLostWorkNotes().slice(notesBefore);
    assert.equal(notes.length, 1, 'told once, with the next message');
    assert.ok(notes[0].text.includes('BG-11 [fake:answer]') && notes[0].text.includes(`«${getFakeBackgroundTaskDescription('BG-10')}»`), notes[0].text);
    assert.ok(notes[0].text.includes('(the conversation moved to another backend)'), notes[0].text);
    assert.deepEqual(listLostWorkLines('BG-10'), [], 'no lost-work line beside the switch reply');
    assert.ok(!checkIsPidAlive(pid), 'the old process is gone');
  });

  it('`/claude_mode` while only a turn runs and a message waits to be taken in: no "background tasks stopped" line, the agent hears of the cut-off turn', async () => {
    fakeTelegram.pushOperatorMessage(topicThreadId, 'BG-12 [fake:hang-once] a turn that never ends');
    await getCharness().waitFor('BG-12\'s turn to start', replyTimeoutMs, () => getAgentTurns(getLayout(), 'BG-12').length === 1);
    const hungPid = getTurnPid('BG-12');
    fakeTelegram.pushOperatorMessage(topicThreadId, 'BG-13 [fake:answer] written while the turn runs');
    // Read by the process but never echoed (the fake runs one turn at a time): input the CLI has not taken in.
    await getCharness().waitFor('BG-13 to reach the busy process', replyTimeoutMs, () => listPrompts().some((prompt) => prompt.pid === hungPid && prompt.text.includes('BG-13')));
    const notesBefore = listLostWorkNotes().length;
    const messagesBefore = topic.listMessages().length;
    const reply = await topic.sendAndAwaitReply('/claude_mode json', 'same conversation resumed');
    assert.ok(!reply.text.includes(enDict['fallback.backgroundStopped']), `no background work was stopped:\n${reply.text}`);
    await sendAndAwaitTurnEnd('BG-14', '[fake:answer] go on');
    await getCharness().waitFor('the note about the cut-off turn', replyTimeoutMs, () => listLostWorkNotes().length > notesBefore);
    const notes = listLostWorkNotes().slice(notesBefore);
    assert.equal(notes.length, 1, 'told once');
    assert.ok(notes[0].text.includes('the turn you were in the middle of, which was cut off') && !notes[0].text.includes('background tasks'), notes[0].text);
    assert.ok(!topic.listMessages().slice(messagesBefore).some((message) => message.text.includes(enDict['fallback.backgroundStopped'])), 'no line about background work, then or later');
    assert.ok(!checkIsPidAlive(hungPid), 'the old process is gone');
  });

  it('`/claude_mode` whose bound folder is gone while a task runs: the folder error still says the background work stopped', async () => {
    const pid = await startBackgroundTask('BG-15');
    fs.rmSync(path.join(getLayout().workRoot, projectFolder), { recursive: true, force: true });
    const reply = await topic.sendAndAwaitReply('/claude_mode perturn', enDict['fallback.backgroundStopped']);
    assert.ok(reply.text.indexOf(enDict['fallback.backgroundStopped']) > 0 && !reply.text.includes('same conversation resumed'), `the folder error, then the line:\n${reply.text}`);
    await getCharness().waitFor('the old process to end', replyTimeoutMs, () => !checkIsPidAlive(pid));
  });
});
