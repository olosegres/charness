/**
 * @description The native-Windows notice at PROCESS level: the BUILT charness started the way an isolated instance is
 * (`scripts/run-isolated.sh`'s environment) against the fake Bot API of `telegramE2e/fakeTelegram.ts`, with
 * `process.platform` forced to `win32` by a preload (no Windows machine needed). One flow, in order:
 *
 *   cold start on «Windows» → the console line is printed; General gets the notice once, in the chat's language, with the
 *     link to SETUP.md; `/doctor` carries the same line as a warning with no dangling dash
 *   → a quick restart (a hot reload): the console line is printed again, General is NOT told twice
 *   → a cold start on Linux (no preload): no console line, no notice, and `/doctor` has no such line
 *
 * Nothing leaves the machine: the Bot API is on loopback. Everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
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
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { t } from '../i18n';
import { getNativeWindowsNotice, nativeWindowsSetupUrl } from '../utils/nativeWindows';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const launchLine = 'Launching Telegraf bot (long polling';
const consoleLinePrefix = '[platform] Native Windows is limited';
/** The one field of `state.json` the test touches: the stamp the boot classifier reads (absent ⇒ the next start is cold). */
interface StateFileHeartbeat {
  lastHeartbeatAt?: number;
}

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let defaultTmuxSessionsBefore: string[] = [];
let forcedWindowsLaunch: { file: string; args: readonly string[] };

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

/** Start charness on the instance — as «Windows» or as the host's own platform — and wait for its first poll. */
async function startCharness(options: { isWindows: boolean }): Promise<string> {
  charness = new IsolatedCharness(getLayout(), options.isWindows ? { launch: forcedWindowsLaunch } : {});
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
  return charness.output;
}

/** The notice posts in General — the whole message, not a `/doctor` report that carries the same line. */
function listNoticeMessages(): string[] {
  const noticeText = getNativeWindowsNotice('win32', t);
  assert.ok(noticeText !== null);
  return general.listMessages().map((message) => message.text).filter((text) => text === `⚠️ ${noticeText}`);
}

describe('Native Windows notice end to end: built charness, platform forced to win32, fake Bot API', () => {
  before(async () => {
    if (!fs.existsSync(builtCliPath)) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-nativewin-', ['app'], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);

    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    const preloadPath = path.join(layout.testRoot, 'forceWin32.cjs');
    fs.writeFileSync(preloadPath, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
    forcedWindowsLaunch = { file: process.execPath, args: ['--require', preloadPath, builtCliPath] };

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(layout, {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: layout.dataDir,
      WORK_ROOT: layout.workRoot,
      TMUX_TMPDIR: layout.tmuxTmpDir,
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

  it('a cold start on Windows prints the console line and tells General once, with the link', async () => {
    const runOutput = await startCharness({ isWindows: true });
    assert.match(runOutput, /Boot mode:\s+COLD START/, 'the first start is a cold start');
    assert.ok(runOutput.includes(consoleLinePrefix), `the console line is printed: ${runOutput.slice(0, 1500)}`);

    await general.waitForMessage('the native Windows notice in General', (message) => message.text === `⚠️ ${getNativeWindowsNotice('win32', t)}`);
    const [notice] = listNoticeMessages();
    assert.ok(notice.includes(nativeWindowsSetupUrl), 'the notice carries the SETUP.md link');
    assert.equal(listNoticeMessages().length, 1, 'General was told once');
  });

  it('/doctor shows the same line as a warning with no dangling dash', async () => {
    const report = await general.sendAndAwaitReply('/doctor', 'Charness Doctor');
    const noticeText = getNativeWindowsNotice('win32', t);
    assert.ok(noticeText !== null);
    const doctorLine = report.text.split('\n').find((line) => line.includes(noticeText));
    assert.equal(doctorLine, `⚠️ ${noticeText}`, `the doctor line is the notice behind a warning sign, nothing after it:\n${report.text}`);
  });

  it('a quick restart (a hot reload) prints the console line again but does not tell General twice', async () => {
    await getCharness().stop();
    const runOutput = await startCharness({ isWindows: true });
    assert.match(runOutput, /Boot mode:\s+HOT RELOAD/, 'a restart within a minute is a hot reload');
    assert.ok(runOutput.includes(consoleLinePrefix), 'the console line is printed on every start');
    // The notice would have been sent before the first poll; a reply to /doctor comes after it, so it is the barrier.
    await general.sendAndAwaitReply('/doctor', 'Charness Doctor');
    assert.equal(listNoticeMessages().length, 1, 'General was not told a second time');
  });

  it('a cold start on Linux is silent: no console line, no notice, no doctor line', async () => {
    await getCharness().stop();
    const statePath = path.join(getLayout().dataDir, 'state.json');
    const state: StateFileHeartbeat = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(state.lastHeartbeatAt !== undefined, 'the previous run left a heartbeat to forget');
    delete state.lastHeartbeatAt;
    fs.writeFileSync(statePath, JSON.stringify(state));

    const runOutput = await startCharness({ isWindows: false });
    assert.match(runOutput, /Boot mode:\s+COLD START/, 'a state with no heartbeat starts cold');
    assert.ok(!runOutput.includes(consoleLinePrefix), 'no console line off Windows');
    const report = await general.sendAndAwaitReply('/doctor', 'Charness Doctor');
    assert.ok(!report.text.includes('Native Windows'), `no doctor line off Windows:\n${report.text}`);
    assert.equal(listNoticeMessages().length, 1, 'General was not told again by a Linux start');
  });
});
