/**
 * @description The Docker side of automatic updates at PROCESS level, on a host without Docker: the image's own `docker/entrypoint.sh`
 * (the loop that keeps the hot supervisor running) and `docker/restart-bot.sh` run for real over a checkout of charness — only their
 * paths (`/opt/charness`, the pid file, the restart marker) point into a temp folder. The container is the ONLY thing missing here.
 *
 *   boot through the entrypoint → `/update` says it runs hot, from which commit; the entrypoint wrote the supervisor's pid
 *   → a commit that touches a file the SUPERVISOR loaded: the update re-executes the supervisor IN PLACE — the entrypoint, which
 *     `wait`s on that pid, sees nothing: no "the bot exited", no restart delay, the same pid in its file, the same process
 *   → `charness-restart-bot` (what the operator ran by hand before) still restarts the bot: the entrypoint starts a new supervisor
 *     at once, on the updated code
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
import { createCheckoutFixture, writePatchedDockerScripts, writeImageInstallStamp, writeYarnStandIn, type CheckoutFixture, type PatchedDockerScripts } from './e2e/checkoutFixture';
import {
  createIsolatedInstanceLayout,
  exitOnSignal,
  getFlowDeadlineMs,
  getFreeFixedPort,
  getIsolatedPath,
  getProcessStartTicks,
  IsolatedCharness,
  listTmuxSessions,
  removeIsolatedInstanceSync,
  writeFakeClaudeLauncher,
  writeInstanceEnvFile,
  type IsolatedInstanceLayout,
} from './e2e/isolatedCharness';
import { launchLine, UpdateFlowDriver } from './e2e/updateFlowDriver';
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
const restartScriptTimeoutMs = 30 * 1000;
/** Short, so a supervisor that EXITS (instead of re-executing) shows at once as the entrypoint's "restarting in 2 s", not as a hang. */
const entrypointRestartDelaySeconds = 2;
const entrypointExitedLine = 'charness: the bot exited';
const entrypointRestartingLine = 'charness: restarting the bot';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let flow: UpdateFlowDriver;
let fixture: CheckoutFixture;
let scripts: PatchedDockerScripts;
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

/** The supervisor the entrypoint started: the pid it wrote, which is also what `charness-restart-bot` signals. */
function readSupervisorPid(): number {
  return Number(fs.readFileSync(scripts.supervisorPidFile, 'utf8').trim());
}

function checkIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The entrypoint IS the instance's process: its output carries the bot's and the entrypoint's own lines. */
async function startEntrypoint(): Promise<void> {
  charness = new IsolatedCharness(getLayout(), { launch: { file: scripts.entrypointPath, args: [] } });
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(hotBootTimeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

function runRestartBotCommand(): { status: number | null; output: string } {
  const result = spawnSync(scripts.restartBotPath, [], {
    env: { PATH: getIsolatedPath(getLayout()), HOME: getLayout().instanceHome },
    encoding: 'utf8',
    timeout: restartScriptTimeoutMs,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('Automatic updates, Docker image: the entrypoint loop and the supervisor that re-executes itself', () => {
  let supervisorPid = 0;
  let supervisorStartTicks: number | null = null;
  let supervisorCommit = '';

  before(async () => {
    if (!fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'cli.js'))) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-upd-img-', ['project'], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);
    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fixture = createCheckoutFixture(getLayout().testRoot, getLayout().instanceHome, { isolatedNodeModules: true });
    // `dist/` as `tsc` itself writes it for THIS tree, so the watcher's first emit changes nothing the supervisor has hashed.
    const compiled = spawnSync(process.execPath, [path.join('node_modules', 'typescript', 'bin', 'tsc')], { cwd: fixture.checkoutDir, encoding: 'utf8', timeout: tscTimeoutMs });
    assert.equal(compiled.status, 0, `the checkout compiles: ${compiled.stdout}${compiled.stderr}`);
    writeImageInstallStamp(fixture.checkoutDir);
    writeYarnStandIn(getLayout().binDir);
    scripts = writePatchedDockerScripts(path.join(getLayout().testRoot, 'image'), fixture.checkoutDir, entrypointRestartDelaySeconds);

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    flow = new UpdateFlowDriver(fakeTelegram, getCharness, general);
    const apiRoot = await fakeTelegram.start();
    // No OpenCode binary on the instance's PATH: the supervisor starts no server (the hot flow covers the re-exec adopting one).
    writeInstanceEnvFile(getLayout(), {
      TELEGRAM_BOT_TOKEN: fakeBotToken,
      TELEGRAM_API_ROOT: apiRoot,
      ALLOWED_GROUP_ID: group.id.toString(),
      CHAT_MODE: 'group',
      DATA_DIR: getLayout().dataDir,
      WORK_ROOT: getLayout().workRoot,
      TMUX_TMPDIR: getLayout().tmuxTmpDir,
      CLAUDE_BIN: writeFakeClaudeLauncher(getLayout(), null),
      SCHEDULER_MCP_PORT: (await getFreeFixedPort()).toString(),
      ...getTelegramFlowTestTimingsEnv(),
    });
  });

  after(async () => {
    // The entrypoint's own TERM trap stops the supervisor it started and exits.
    await charness?.stop();
    removeInstanceSync();
    await fakeTelegram?.stop();
    process.off('exit', removeInstanceSync);
    process.off('SIGINT', exitOnSignal);
    process.off('SIGTERM', exitOnSignal);
    assert.deepEqual(listTmuxSessions([]), defaultTmuxSessionsBefore, 'the default tmux server was not touched');
  });

  it('boots the hot supervisor through the entrypoint; it wrote the supervisor\'s pid, and `/update` says it runs hot, from which commit', async () => {
    await startEntrypoint();
    supervisorPid = readSupervisorPid();
    supervisorStartTicks = getProcessStartTicks(supervisorPid);
    assert.ok(supervisorPid > 0 && checkIsProcessAlive(supervisorPid), 'the pid file names a live supervisor');
    assert.notEqual(supervisorPid, flow.getPid(), 'a supervisor of its own — the entrypoint is its parent');
    await flow.openScreen(`· git @ ${fixture.getHead()} · hot`);
  });

  it('a commit the supervisor loaded: it re-executes IN PLACE — the entrypoint sees no exit, no restart; the same pid, the same process', async () => {
    const firstCommit = fixture.getHead();
    supervisorCommit = fixture.pushCommit(
      {
        'CHANGELOG.md': (previous) => previous.replace('## Unreleased\n', '## Unreleased\n\n**A supervisor entry.** Details of it.\n'),
        'src/cli/hot.ts': (previous) => `${previous}\n// a change in a file the supervisor loaded\n`,
      },
      'feat: a supervisor change',
    );
    await flow.checkNow(`${supervisorCommit} is out`);
    const bootsBefore = flow.countBoots();
    await flow.tap(`upd_go_${supervisorCommit}`);

    // The reload brings the first new worker; its record check then re-executes the supervisor, whose new worker is the second.
    await getCharness().waitFor('two more boots: the reloaded worker and the one of the re-executed supervisor', reloadTimeoutMs, () => flow.countBoots() >= bootsBefore + 2);
    assert.ok(getCharness().output.includes('charness hot: re-executing the supervisor (a file it loaded changed)'));
    await flow.waitForGeneralMessage('the "Updated" message', replyTimeoutMs, (message) => message.text.startsWith(`🔄 Charness updated: ${firstCommit} → ${supervisorCommit}`));

    assert.equal(readSupervisorPid(), supervisorPid, 'the entrypoint\'s pid file still names the supervisor');
    assert.equal(getProcessStartTicks(supervisorPid), supervisorStartTicks, 'the same process, not a new one that reuses the pid');
    assert.ok(!getCharness().output.includes(entrypointExitedLine), 'the entrypoint never saw the supervisor exit');
    assert.ok(!getCharness().output.includes(entrypointRestartingLine), 'and never restarted it');
    await flow.openScreen(`· git @ ${supervisorCommit} · hot`);
  });

  it('`charness-restart-bot` still restarts the bot: the entrypoint starts a new supervisor at once, on the updated code', async () => {
    const bootsBefore = flow.countBoots();
    const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
    const restart = runRestartBotCommand();
    assert.equal(restart.status, 0, restart.output);
    assert.ok(restart.output.includes('the bot is stopping'), restart.output);

    await getCharness().waitFor('the entrypoint to start a new supervisor', reloadTimeoutMs, () => flow.countBoots() > bootsBefore && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
    assert.ok(getCharness().output.includes(entrypointRestartingLine), 'the entrypoint took the restart marker, not the crash path');
    assert.ok(!getCharness().output.includes(entrypointExitedLine), 'the stop was not taken for a crash');
    const newSupervisorPid = readSupervisorPid();
    assert.notEqual(newSupervisorPid, supervisorPid, 'a new supervisor');
    assert.ok(checkIsProcessAlive(newSupervisorPid));
    assert.ok(!checkIsProcessAlive(supervisorPid), 'and the old one is gone');
    await flow.openScreen(`· git @ ${supervisorCommit} · hot`);
  });
});
