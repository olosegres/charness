/**
 * @description The git-checkout side of automatic updates in HOT mode, at PROCESS level: `charness hot` (the real supervisor, the real
 * `tsc -w` and nodemon) runs from a checkout of charness — a copy of this repository's sources in a temp folder, a bare "remote", a
 * second clone that pushes — against the fake Bot API, with `/update` as the operator's control. One flow, in order:
 *
 *   boot → `/update` says it runs hot, from which commit
 *   → a commit that touches a file only the WORKER loads: the tap pulls it, `tsc -w` rebuilds, nodemon replaces the worker by itself,
 *     "Updated a → b" is said by the new worker — and the supervisor is neither restarted nor re-executed (same pid, one start)
 *   → a commit that touches a file the SUPERVISOR loaded: the new worker finds its supervisor's record stale and, at its idle point,
 *     asks it to re-execute: the supervisor stops its watchers and replaces itself — the SAME pid — and a worker starts again on the
 *     new code; the update is announced once
 *   → a commit that changes no compiled source (docs, the CHANGELOG): `tsc -w` writes nothing under `dist/`, so nodemon would never
 *     replace the worker — the update asks for the reload itself (touching the worker entry), the new worker announces it, and the
 *     build deadline never rolls the good pull back
 *
 * The supervisor also owns an OpenCode server (a fake `opencode serve` it spawned and a fake server answering on its port): the
 * re-executed supervisor adopts that very server — no second one is spawned and the first one lives on.
 *
 * Nothing leaves the machine; everything the test starts is stopped in `after`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
import { FakeOpenCodeServer, writeFakeOpenCodeBinary } from './openCodeE2e/fakeOpenCodeServer';
import { createCheckoutFixture, writeYarnStandIn, type CheckoutFixture } from './e2e/checkoutFixture';
import {
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getFreePort,
  getProcessStartTicks,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { launchLine, UpdateFlowDriver } from './e2e/updateFlowDriver';
import { readHotSupervisorRecord } from '../selfUpdate/hotSupervisor';
import { getTelegramFlowTestTimingsEnv } from './telegramE2e/telegramFlowTimings';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

/** The supervisor compiles the whole tree once before it starts its first worker. */
const hotBootTimeoutMs = 3 * 60 * 1000;
const replyTimeoutMs = 20 * 1000;
/** A pull, `tsc -w`'s rebuild, nodemon's reload and the new worker's boot. */
const reloadTimeoutMs = 4 * 60 * 1000;
const tscTimeoutMs = 5 * 60 * 1000;
const fakeOpenCodeVersion = '1.17.11';
const defaultOpenCodeModel = 'anthropic/claude-sonnet-4-6';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let flow: UpdateFlowDriver;
let fixture: CheckoutFixture;
let fakeOpenCode: FakeOpenCodeServer;
let openCodePort = 0;
/** The pids of the `opencode serve` processes the supervisor spawned (the fake binary appends its own). */
let servePidFile = '';
let defaultTmuxSessionsBefore: string[] = [];

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

function listServePids(): number[] {
  return fs.existsSync(servePidFile) ? fs.readFileSync(servePidFile, 'utf8').split('\n').filter(Boolean).map(Number) : [];
}

function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start the HOT supervisor from the checkout and wait for its first worker's first poll to reach the fake Bot API. */
async function startCharness(): Promise<void> {
  charness = new IsolatedCharness(getLayout(), { cliPath: fixture.cliPath, cliArgs: ['hot'] });
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(hotBootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

function addChangelogEntry(headline: string): (previous: string) => string {
  return (previous) => previous.replace('## Unreleased\n', `## Unreleased\n\n**${headline}** Details of it.\n`);
}

function countUpdatedMessages(): number {
  return general.listMessages().filter((message) => message.text.startsWith('🔄 Charness updated:')).length;
}

describe('Automatic updates, git checkout (hot mode): the real supervisor, tsc -w and nodemon', () => {
  let supervisorPid = 0;
  let supervisorStartTicks: number | null = null;
  let firstCommit = '';
  let workerOnlyCommit = '';
  let supervisorCommit = '';

  before(async () => {
    if (!fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'cli.js'))) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-upd-hot-', ['project'], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);
    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fixture = createCheckoutFixture(getLayout().testRoot, getLayout().instanceHome);
    // `dist/` as `tsc` itself writes it for THIS tree, so the watcher's first emit changes nothing the supervisor has hashed.
    const compiled = spawnSync(process.execPath, [path.join('node_modules', 'typescript', 'bin', 'tsc')], { cwd: fixture.checkoutDir, encoding: 'utf8', timeout: tscTimeoutMs });
    assert.equal(compiled.status, 0, `the checkout compiles: ${compiled.stdout}${compiled.stderr}`);
    writeYarnStandIn(getLayout().binDir);
    firstCommit = fixture.getHead();

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    flow = new UpdateFlowDriver(fakeTelegram, getCharness, general);
    const apiRoot = await fakeTelegram.start();
    // The OpenCode server the supervisor owns: the fake binary's `serve` only records its pid and waits; the flow answers on its port.
    servePidFile = path.join(getLayout().fakeLogDir, 'opencode-serve.pids');
    openCodePort = await getFreePort();
    fakeOpenCode = new FakeOpenCodeServer({ version: fakeOpenCodeVersion, models: [defaultOpenCodeModel], defaultModel: defaultOpenCodeModel });
    writeFakeOpenCodeBinary(getLayout().binDir, { version: fakeOpenCodeVersion, models: [defaultOpenCodeModel], servePidFile });
    writeInstanceEnvFile(getLayout(), {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: getLayout().dataDir,
      WORK_ROOT: getLayout().workRoot,
      TMUX_TMPDIR: getLayout().tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(getLayout(), null),
      OPENCODE_URL: `http://127.0.0.1:${openCodePort}`,
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
  });

  after(async () => {
    await charness?.stop();
    for (const pid of listServePids()) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    removeInstanceSync();
    await fakeTelegram?.stop();
    await fakeOpenCode?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
    assert.deepEqual(fakeOpenCode.unhandled, [], 'the bot asked the fake OpenCode for nothing it does not model');
  });

  it('boots the hot supervisor from the checkout; `/update` says it runs hot, from which commit; the supervisor wrote its record', async () => {
    // The supervisor spawns `opencode serve` before it starts its watchers and waits for a server on that port: answer there.
    const starting = startCharness();
    await getCharness().waitFor('the supervisor to spawn `opencode serve`', hotBootTimeoutMs, () => listServePids().length > 0);
    await fakeOpenCode.start(openCodePort);
    await starting;
    assert.equal(listServePids().length, 1, 'one OpenCode server, spawned by the supervisor');
    supervisorPid = flow.getPid();
    supervisorStartTicks = getProcessStartTicks(supervisorPid);
    await flow.openScreen(`· git @ ${firstCommit} · hot`);
    const record = readHotSupervisorRecord(getLayout().dataDir);
    assert.ok(record, 'the supervisor recorded what it loaded');
    assert.equal(record.pid, supervisorPid);
    assert.ok(record.modules.some((module) => module.path === 'cli/hot.js'));
  });

  it('a commit only the worker loads: the pull is followed by a rebuild and a worker reload — the supervisor is neither restarted nor re-executed', async () => {
    workerOnlyCommit = fixture.pushCommit(
      { 'CHANGELOG.md': addChangelogEntry('A worker-only entry.'), 'src/bot.ts': (previous) => `${previous}\n// a worker-only change\n` },
      'feat: a worker-only change',
    );
    await flow.checkNow(`${workerOnlyCommit} is out`);
    await flow.tap(`upd_go_${workerOnlyCommit}`);
    await flow.waitForRestartInPlace('a new worker on the rebuilt code', reloadTimeoutMs);

    const updated = await flow.waitForGeneralMessage('the "Updated" message', replyTimeoutMs, (message) => message.text.startsWith('🔄 Charness updated:'));
    assert.equal(updated.text, [`🔄 Charness updated: ${firstCommit} → ${workerOnlyCommit} (1 commits)`, '• A worker-only entry.'].join('\n'));
    assert.equal(fixture.getHead(), workerOnlyCommit);
    assert.equal(getCharness().pid, supervisorPid, 'the same supervisor');
    assert.equal(getProcessStartTicks(supervisorPid), supervisorStartTicks);
    assert.ok(!getCharness().output.includes('re-executing the supervisor'), 'a worker-only change never re-executes the supervisor');
    assert.equal(countUpdatedMessages(), 1);
  });

  it('a commit the supervisor itself loaded: the new worker asks it to re-execute; the SAME process replaces itself and a worker starts again — announced once', async () => {
    supervisorCommit = fixture.pushCommit(
      { 'CHANGELOG.md': addChangelogEntry('A supervisor entry.'), 'src/cli/hot.ts': (previous) => `${previous}\n// a change in a file the supervisor loaded\n` },
      'feat: a supervisor change',
    );
    await flow.openScreen(`· git @ ${workerOnlyCommit} · hot`);
    await flow.checkNow(`${supervisorCommit} is out`);
    const bootsBefore = flow.countBoots();
    const [serverPid] = listServePids();
    const healthProbesBefore = fakeOpenCode.listRequests('GET', '/global/health').length;
    await flow.tap(`upd_go_${supervisorCommit}`);

    // The reload brings the first new worker; its record check then re-executes the supervisor, whose new worker is the second.
    await getCharness().waitFor('two more boots: the reloaded worker and the one of the re-executed supervisor', reloadTimeoutMs, () => flow.countBoots() >= bootsBefore + 2);
    assert.ok(getCharness().output.includes('charness hot: re-executing the supervisor (a file it loaded changed)'));
    assert.equal(getCharness().pid, supervisorPid, 'the same pid');
    assert.equal(getProcessStartTicks(supervisorPid), supervisorStartTicks, 'the same process, not a new one that reuses the pid');
    assert.deepEqual(listServePids(), [serverPid], 'no second OpenCode server was spawned');
    assert.ok(checkIsProcessAlive(serverPid), 'and the one the supervisor owned lives on');
    assert.ok(fakeOpenCode.listRequests('GET', '/global/health').length > healthProbesBefore, 'the re-executed supervisor looked for it and adopted it');

    await flow.waitForGeneralMessage('the second "Updated" message', replyTimeoutMs, (message) => message.text.startsWith(`🔄 Charness updated: ${workerOnlyCommit} → ${supervisorCommit}`));
    const record = readHotSupervisorRecord(getLayout().dataDir);
    assert.ok(record);
    assert.equal(record.pid, supervisorPid);
    assert.equal(countUpdatedMessages(), 2, 'one announcement per update — the re-executed supervisor\'s worker says nothing more');
    await flow.openScreen(`· git @ ${supervisorCommit} · hot`);
  });
  it('a pull that changes no compiled source (docs, the CHANGELOG): nothing is rebuilt, so the update asks the worker to reload — a new worker announces it and the checkout is NOT put back', async () => {
    const docsCommit = fixture.pushCommit(
      { 'CHANGELOG.md': addChangelogEntry('A docs-only entry.'), 'docs/notes.md': '# Notes\n\nNothing here is compiled.\n' },
      'docs: a change tsc has nothing to compile in',
    );
    await flow.checkNow(`${docsCommit} is out`);
    const reexecutionsBefore = getCharness().output.split('re-executing the supervisor').length - 1;
    await flow.tap(`upd_go_${docsCommit}`);
    await flow.waitForRestartInPlace('a new worker, asked for by the update itself (tsc -w wrote nothing under dist/)', reloadTimeoutMs);

    const updated = await flow.waitForGeneralMessage('the "Updated" message', replyTimeoutMs, (message) => message.text.startsWith(`🔄 Charness updated: ${supervisorCommit} → ${docsCommit}`));
    assert.equal(updated.text, [`🔄 Charness updated: ${supervisorCommit} → ${docsCommit} (1 commits)`, '• A docs-only entry.'].join('\n'));
    assert.equal(fixture.getHead(), docsCommit, 'the checkout stays on the pulled commit');
    assert.ok(getCharness().output.includes(`[update] ${docsCommit}: no compiled source changed, so no rebuild would replace the worker — asked it to reload`));
    assert.equal(getCharness().pid, supervisorPid, 'the same supervisor');
    assert.equal(getCharness().output.split('re-executing the supervisor').length - 1, reexecutionsBefore, 'a docs-only change never re-executes the supervisor');
    assert.equal(general.listMessages().some((message) => message.text.startsWith('⚠️ Automatic update to')), false, 'no failure line: nothing was rolled back');
    await flow.openScreen(`· git @ ${docsCommit} · hot`);
  });
});
