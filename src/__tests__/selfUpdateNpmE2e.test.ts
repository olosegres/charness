/**
 * @description The npm side of automatic updates, at PROCESS level: charness installed GLOBALLY from a tarball into a temp prefix
 * (the real `npm`, a loopback registry that serves the package under test and proxies its dependencies), started from that install
 * against the fake Bot API, with `/update` as the operator's control. One flow, in order:
 *
 *   boot from the install → `/update`: what runs, the mode, "Not checked yet"
 *   → «Check now» finds 9.2.0 and offers it; another topic sees the screen without buttons
 *   → «Update to 9.2.0 now»: the real `npm install -g` into the SAME prefix, the self-check, a restart in place — the SAME pid,
 *     the launch environment (not the loaded `.env`), the edited `.env` read afresh — then "Updated 9.1.0 → 9.2.0" with the
 *     list, the to-do first, pinned, and `/version` naming the new version
 *   → a version that cannot start (its `bot.js` does not parse) is installed, fails its self-check and is rolled back to the version
 *     that runs: one line, the same process, never offered again
 *   → a deprecated version is not offered; a major is offered with its tap, not installed by itself; a version that needs a newer
 *     Node is named and has no tap
 *   → an operator's own `npm i -g` while the bot runs: the next check notices it and the bot restarts onto it at its idle point
 *   → a read-only prefix can only notify: the screen says why and names the command, «update now» is refused
 *
 * Nothing leaves the machine but the dependency downloads of a real install; the Bot API is on loopback. Everything the test starts
 * is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeTelegram, generalTopicThreadId, type FakeTelegramMessage } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { FakeNpmRegistry } from './e2e/fakeNpmRegistry';
import {
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  getIsolatedPath,
  getProcessEnvNames,
  getProcessStartTicks,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { getInstalledPackageRoot, installCharnessGlobally, packCharnessVersion, readInstalledVersion, type NpmEnvironment } from './e2e/updateFlowKit';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const otherTopicThreadId = 111;
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';
const launchLine = 'Launching Telegraf bot (long polling';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
/** A real `npm install -g` with a native build, the self-check and the restart. */
const updateTimeoutMs = 8 * 60 * 1000;
const confirmTimeoutMs = 120 * 1000;

const runningVersion = '9.1.0';
const goodVersion = '9.2.0';
const brokenVersion = '9.3.0';
const deprecatedVersion = '9.4.0';
const needsNewNodeVersion = '9.6.0';
const manualVersion = '9.7.0';
const readOnlyOfferVersion = '9.8.0';
const majorVersion = '10.0.0';

function createChangelog(version: string, extraSections = ''): string {
  return [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    `## ${version} — 2026-10-24`,
    '',
    `**A new board arrived in ${version}.** Details.`,
    '',
    '### Upgrading',
    '- **Rename the old variables.** Before 10.0.',
    '',
    extraSections,
    `## ${runningVersion} — 2026-10-20`,
    '',
    '**Old news.** x',
    '',
  ].join('\n');
}

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let otherTopic: TopicDriver;
let registry: FakeNpmRegistry;
let npmEnvironment: NpmEnvironment;
let prefix = '';
let defaultTmuxSessionsBefore: string[] = [];
let screen: FakeTelegramMessage;

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

function getInstalledCliPath(): string {
  return path.join(getInstalledPackageRoot(prefix), 'dist', 'cli.js');
}

function countBoots(): number {
  return getCharness().output.split(launchLine).length - 1;
}

/** Start charness FROM THE PREFIX'S INSTALL and wait for its first poll to reach the fake Bot API. */
async function startCharness(): Promise<void> {
  charness = new IsolatedCharness(getLayout(), { cliPath: getInstalledCliPath() });
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(bootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

/** The bot's own process replaced itself: one more boot, a new poll — and it is still the process we started. */
async function waitForRestartInPlace(description: string, timeoutMs: number): Promise<void> {
  const bootsBefore = countBoots();
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await getCharness().waitFor(description, timeoutMs, () => countBoots() > bootsBefore && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

/** Open `/update` in General as a NEW message and keep it as the screen the next taps use. */
async function openScreen(expectedText: string): Promise<void> {
  screen = await general.sendAndAwaitReply('/update', expectedText);
}

async function checkNow(expectedText: string): Promise<void> {
  const answer = await general.tapAndAwaitAnswer(screen, 'upd_check');
  assert.equal(answer, 'Checked.');
  await general.waitForMessageText(`the screen to read "${expectedText}"`, screen, (text) => text.includes(expectedText));
}

/** A message of General that takes longer than a command's reply (it comes after an install and a restart). */
async function waitForGeneralMessage(description: string, timeoutMs: number, check: (message: FakeTelegramMessage) => boolean): Promise<FakeTelegramMessage> {
  let found: FakeTelegramMessage | undefined;
  await getCharness().waitFor(description, timeoutMs, () => {
    found = general.listMessages().find(check);
    return found !== undefined;
  });
  if (!found) throw new Error(`no message for ${description}`);
  return found;
}

function getInstalledPid(): number {
  const pid = getCharness().pid;
  assert.ok(pid, 'charness has a pid');
  return pid;
}

describe('Automatic updates, npm: a global install, the fake registry, the fake Bot API', () => {
  let runningPid = 0;
  let runningStartTicks: number | null = null;

  before(async () => {
    if (!fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'cli.js'))) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-upd-npm-', ['project'], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);
    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    // The packages: the one that runs, and every version the flow offers it.
    registry = new FakeNpmRegistry();
    const registryUrl = await registry.start();
    const packDir = path.join(getLayout().testRoot, 'packages');
    const workDir = path.join(getLayout().testRoot, 'pack-work');
    fs.mkdirSync(workDir, { recursive: true });
    const publish = (version: string, options: { changelog?: string; engines?: { node: string }; isBroken?: boolean } = {}): void => {
      const packed = packCharnessVersion(workDir, packDir, { version, changelog: options.changelog ?? createChangelog(version), engines: options.engines, isBroken: options.isBroken });
      registry.publish({ version, manifest: packed.manifest, tarballPath: packed.tarballPath, engines: options.engines });
    };
    publish(runningVersion);
    publish(goodVersion);
    publish(brokenVersion, { isBroken: true });
    publish(deprecatedVersion);
    publish(needsNewNodeVersion, { engines: { node: '>=99' } });
    publish(manualVersion);
    publish(readOnlyOfferVersion);
    publish(majorVersion);
    registry.setLatest(runningVersion);

    // The install under test: a real global install into a temp prefix, with the instance's own HOME (and so npm cache).
    prefix = path.join(getLayout().testRoot, 'prefix');
    npmEnvironment = { home: getLayout().instanceHome, registryUrl, path: getIsolatedPath(getLayout()) };
    await installCharnessGlobally(prefix, runningVersion, npmEnvironment);
    assert.equal(readInstalledVersion(prefix), runningVersion);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    otherTopic = new TopicDriver(fakeTelegram, getCharness, otherTopicThreadId, replyTimeoutMs);
    const apiRoot = await fakeTelegram.start();
    writeInstanceEnvFile(getLayout(), {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: getLayout().dataDir,
      WORK_ROOT: getLayout().workRoot,
      TMUX_TMPDIR: getLayout().tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(getLayout(), null),
      OPENCODE_URL: `http://127.0.0.1:${await getFreePort()}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      // What the bot's own `npm` (the update's install) talks to: the loopback registry, with the instance's cache.
      NPM_CONFIG_REGISTRY: registryUrl,
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    });
  });

  after(async () => {
    await charness?.stop();
    // A read-only prefix cannot be removed until it is writable again.
    if (prefix) {
      makeDirectoryWritable(path.join(prefix, 'lib', 'node_modules'));
      makeDirectoryWritable(path.join(prefix, 'bin'));
    }
    removeInstanceSync();
    await fakeTelegram?.stop();
    await registry?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots from the install and `/update` says what runs, that updates are off in this instance, and that nothing was checked yet', async () => {
    const requestsBeforeBoot = registry.requests.length;
    await startCharness();
    runningPid = getInstalledPid();
    runningStartTicks = getProcessStartTicks(runningPid);
    await openScreen(`Charness ${runningVersion} · npm (${prefix})`);
    assert.match(screen.text, /Automatic updates: OFF/);
    assert.match(screen.text, /Not checked yet\./);
    assert.deepEqual(general.getKeyboardData(screen).flat(), ['upd_mode_on', 'upd_mode_notify', 'upd_mode_off', 'upd_notes_off', 'upd_check']);
    assert.equal(registry.requests.length, requestsBeforeBoot, 'with the mode off the bot has not asked the registry anything');
  });

  it('«Check now» asks the registry, finds the new version and offers its install; another topic sees the same screen without buttons', async () => {
    registry.setLatest(goodVersion);
    await checkNow(`${goodVersion} is out`);
    assert.ok(registry.requests.includes('/charness'));
    assert.ok(general.getKeyboardData(screen).flat().includes(`upd_go_${goodVersion}`), 'the install button is there');

    const other = await otherTopic.sendAndAwaitReply('/update', `Charness ${runningVersion}`);
    assert.deepEqual(otherTopic.getKeyboardData(other), []);
    assert.match(other.text, /Change it in General\.$/);
    assert.match(other.text, new RegExp(`${goodVersion} is out`));
  });

  it('«Update to 9.2.0 now» installs it with the real npm, self-checks it and restarts the SAME process onto it — launch environment, edited .env — then says what changed, pinned', async () => {
    const newWorkRoot = path.join(getLayout().testRoot, 'work-after-update');
    fs.mkdirSync(newWorkRoot);
    const env = fs.readFileSync(getLayout().envFile, 'utf8').replace(`WORK_ROOT=${getLayout().workRoot}`, `WORK_ROOT=${newWorkRoot}`);
    fs.writeFileSync(getLayout().envFile, env);

    const answer = await general.tapAndAwaitAnswer(screen, `upd_go_${goodVersion}`);
    assert.equal(answer, `⬆️ Updating to ${goodVersion} — installing as soon as no agent is working.`);
    await waitForRestartInPlace('the bot to restart onto the new version', updateTimeoutMs);

    assert.equal(readInstalledVersion(prefix), goodVersion, 'npm installed it into the same prefix');
    assert.equal(getCharness().pid, runningPid, 'the same process');
    assert.equal(getProcessStartTicks(runningPid), runningStartTicks, 'not a restarted pid that happens to repeat: the process itself carried on');
    const environNames = getProcessEnvNames(runningPid);
    if (environNames !== null) {
      assert.ok(!environNames.includes('TELEGRAM_BOT_TOKEN'), 'the new image was started with the LAUNCH environment, not with what the .env had loaded');
      assert.ok(environNames.includes('ENV_FILE'));
    }
    assert.ok(getCharness().output.includes(`Work root:        ${newWorkRoot}`), 'the edited .env was read afresh by the new image');

    const updated = await waitForGeneralMessage('the "Updated" message', replyTimeoutMs, (message) => message.text.startsWith(`🔄 Charness updated: ${runningVersion} → ${goodVersion}`));
    assert.equal(
      updated.text,
      [
        `🔄 Charness updated: ${runningVersion} → ${goodVersion}`,
        'To do:',
        '• Rename the old variables.',
        goodVersion,
        `• A new board arrived in ${goodVersion}.`,
      ].join('\n'),
    );
    assert.ok(fakeTelegram.listPinnedMessageIds().includes(updated.message_id), 'the range has an Upgrading entry: the operator must act, the message is pinned');

    const versionReply = await general.sendAndAwaitReply('/version', goodVersion);
    assert.doesNotMatch(versionReply.text, new RegExp(runningVersion.replaceAll('.', '\\.')));
  });

  it('the update is confirmed after the new version has stayed up: the pending marker is gone', async () => {
    const markerPath = path.join(getLayout().dataDir, 'update-pending.json');
    await getCharness().waitFor('the update to be confirmed', confirmTimeoutMs, () => !fs.existsSync(markerPath));
  });

  it('a version that cannot start is installed, fails its self-check and is rolled back to the one that runs: one line, the same process, never offered again', async () => {
    registry.setLatest(brokenVersion);
    await openScreen(`Charness ${goodVersion}`);
    await checkNow(`${brokenVersion} is out`);
    const bootsBefore = countBoots();
    await general.tapAndAwaitAnswer(screen, `upd_go_${brokenVersion}`);
    const failure = await waitForGeneralMessage('the failure line', updateTimeoutMs, (message) => message.text.startsWith(`⚠️ Automatic update to ${brokenVersion} failed`));
    assert.equal(
      failure.text,
      [`⚠️ Automatic update to ${brokenVersion} failed: the new version did not start. Still running ${goodVersion}.`, 'Update by hand: npm install -g charness@latest'].join('\n'),
    );
    assert.ok(!fakeTelegram.listPinnedMessageIds().includes(failure.message_id), 'a rollback that worked needs no pin');
    assert.equal(readInstalledVersion(prefix), goodVersion, 'the previous version was put back');
    assert.equal(countBoots(), bootsBefore, 'the bot never restarted');
    assert.equal(getCharness().pid, runningPid);

    await checkNow('up to date');
    assert.equal(general.getKeyboardData(screen).flat().some((data) => data.startsWith('upd_go_')), false, 'a version that failed is not offered again');
  });

  it('a deprecated version is not offered; a major is offered with its tap and not installed by itself; a version that needs a newer Node is named and has no tap', async () => {
    registry.deprecate(deprecatedVersion, 'use a newer one');
    registry.setLatest(deprecatedVersion);
    await checkNow('up to date');

    registry.setLatest(majorVersion);
    await checkNow(`${majorVersion} is a major version — not installed by itself`);
    assert.ok(general.getKeyboardData(screen).flat().includes(`upd_go_${majorVersion}`));

    registry.setLatest(needsNewNodeVersion);
    await checkNow(`${needsNewNodeVersion} needs Node >=99`);
    assert.match(screen.text, /\(this one runs \d+\.\d+\.\d+\)/);
    assert.equal(general.getKeyboardData(screen).flat().some((data) => data.startsWith('upd_go_')), false);
    assert.equal(readInstalledVersion(prefix), goodVersion, 'none of these touched the install');
  });

  it('an operator\'s own `npm i -g` while the bot runs: «Check now» sees the newer install, and its tap restarts the bot onto it without installing twice', async () => {
    await installCharnessGlobally(prefix, manualVersion, npmEnvironment);
    assert.equal(readInstalledVersion(prefix), manualVersion);
    registry.setLatest(manualVersion);
    const registryRequestsBefore = registry.requests.filter((request) => request.endsWith('.tgz')).length;
    await checkNow(`${manualVersion} is out`);
    await general.tapAndAwaitAnswer(screen, `upd_go_${manualVersion}`);
    await waitForRestartInPlace('the bot to restart onto the version installed by hand', updateTimeoutMs);
    assert.equal(getCharness().pid, runningPid, 'the same process');
    assert.equal(registry.requests.filter((request) => request.endsWith('.tgz')).length, registryRequestsBefore, 'the bot did not download the version again');

    const updated = await waitForGeneralMessage('the "Updated" line', replyTimeoutMs, (message) => message.text.startsWith(`🔄 Charness updated: ${goodVersion} → ${manualVersion}`));
    assert.match(updated.text, new RegExp(`• A new board arrived in ${manualVersion}\\.`));
  });

  it('a read-only prefix can only notify: the screen says why and names the command, «update now» is refused', async () => {
    await getCharness().stop();
    // The install is read-only for the user that runs the bot: no directory of it can be written.
    makeDirectoryReadOnly(path.join(prefix, 'lib', 'node_modules'));
    makeDirectoryReadOnly(path.join(prefix, 'bin'));
    try {
      await startCharness();
      registry.setLatest(readOnlyOfferVersion);
      await openScreen(`Charness ${manualVersion} · npm, read-only folder — can only notify`);
      assert.match(screen.text, /Automatic updates: OFF/);
      await checkNow(`${readOnlyOfferVersion} is out — I will say so ~`);
      assert.match(screen.text, /Update by hand: npm install -g charness@latest$/);
      assert.equal(general.getKeyboardData(screen).flat().some((data) => data.startsWith('upd_go_')), false, 'nothing it could install');

      const refused = await general.sendAndAwaitReply('/update now', 'cannot update itself');
      assert.match(refused.text, /update by hand/);
      assert.equal(readInstalledVersion(prefix), manualVersion);
    } finally {
      makeDirectoryWritable(path.join(prefix, 'lib', 'node_modules'));
      makeDirectoryWritable(path.join(prefix, 'bin'));
    }
  });
});

/** A directory the user cannot write — what a root-owned npm prefix looks like to the bot (it checks `lib/node_modules` and `bin`). */
function makeDirectoryReadOnly(directory: string): void {
  fs.chmodSync(directory, 0o555);
}

function makeDirectoryWritable(directory: string): void {
  if (fs.existsSync(directory)) fs.chmodSync(directory, 0o755);
}
