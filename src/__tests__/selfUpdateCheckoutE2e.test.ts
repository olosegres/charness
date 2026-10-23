/**
 * @description The git-checkout side of automatic updates, at PROCESS level, in plain mode (`node dist/cli.js`): the bot runs from a
 * checkout of charness (a copy of this repository's sources in a temp folder, a bare "remote", a second clone that pushes), against
 * the fake Bot API, with `/update` as the operator's control. One flow, in order:
 *
 *   boot → `/update` names the commit it runs
 *   → somebody pushes a commit with a CHANGELOG entry: «Check now» offers it; «Update now» pulls it with `scripts/self-update.sh`,
 *     builds, self-checks and restarts the SAME process; "Updated a → b (1 commits)" lists the entry the update ADDED
 *   → a commit that does not compile is pulled, fails its build, and the checkout is put back on the commit that ran and rebuilt: one
 *     line, the same process, never offered again
 *   → a checkout with local changes is left alone (the screen says why) and offered again once they are gone
 *   → a range that adds a MIGRATION_*.md is offered, not pulled by itself; its tap pulls it
 *
 * The build is the real `tsc` (a stand-in `yarn` runs it); nothing leaves the machine.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeTelegram, generalTopicThreadId } from './telegramE2e/fakeTelegram';
import { TopicDriver } from './telegramE2e/topicDriver';
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
import { readUpdatePending, writeUpdatePending } from '../selfUpdate/updatePending';

const group = { id: -1001111111111, title: 'ExampleGroup' };
const operator = { id: 424242, is_bot: false, first_name: 'Operator' };
const botUser = { id: 7000000001, is_bot: true, first_name: 'Fake bot', username: 'fake_charness_bot' };
/** Not a Telegram token: the fake Bot API accepts any `/bot<token>/` path, and the real host is never contacted. */
const fakeBotToken = '1000000001:fake-token-for-the-loopback-bot-api';

const bootTimeoutMs = 60 * 1000;
const replyTimeoutMs = 20 * 1000;
/** A pull, a real `tsc` build, the self-check and the restart. */
const updateTimeoutMs = 5 * 60 * 1000;
const brokenLine = 'export const brokenFlowValue: number = "not a number";';

let layout: IsolatedInstanceLayout | null = null;
let charness: IsolatedCharness | null = null;
let fakeTelegram: FakeTelegram;
let general: TopicDriver;
let flow: UpdateFlowDriver;
let fixture: CheckoutFixture;
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

/** Start charness FROM THE CHECKOUT's build and wait for its first poll to reach the fake Bot API. */
async function startCharness(timeoutMs: number = bootTimeoutMs): Promise<void> {
  charness = new IsolatedCharness(getLayout(), { cliPath: fixture.cliPath });
  const pollsBefore = fakeTelegram.listCalls('getUpdates').length;
  await charness.start(timeoutMs, (runOutput) => runOutput.includes(launchLine) && fakeTelegram.listCalls('getUpdates').length > pollsBefore);
}

function addChangelogEntry(headline: string): (previous: string) => string {
  return (previous) => previous.replace('## Unreleased\n', `## Unreleased\n\n**${headline}** Details of it.\n`);
}

describe('Automatic updates, git checkout (plain mode): a checkout, a bare remote, the fake Bot API', () => {
  let runningPid = 0;
  let runningStartTicks: number | null = null;
  let firstCommit = '';
  let secondCommit = '';

  before(async () => {
    if (!fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'cli.js'))) throw new Error('Built CLI is missing. Run `yarn build` before `yarn test`.');
    layout = createIsolatedInstanceLayout('charness-upd-git-', ['project'], getFlowDeadlineMs());
    defaultTmuxSessionsBefore = listTmuxSessions([]);
    process.on('exit', removeInstanceSync);
    process.once('SIGINT', exitOnSignal);
    process.once('SIGTERM', exitOnSignal);

    fixture = createCheckoutFixture(getLayout().testRoot, getLayout().instanceHome);
    writeYarnStandIn(getLayout().binDir);
    firstCommit = fixture.getHead();

    fakeTelegram = new FakeTelegram({ botUser, operator, group });
    general = new TopicDriver(fakeTelegram, getCharness, generalTopicThreadId, replyTimeoutMs);
    flow = new UpdateFlowDriver(fakeTelegram, getCharness, general);
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

  it('boots from the checkout and `/update` names the commit it runs', async () => {
    await startCharness();
    runningPid = flow.getPid();
    runningStartTicks = getProcessStartTicks(runningPid);
    await flow.openScreen(`· git @ ${firstCommit}`);
    assert.match(flow.getScreen().text, /Automatic updates: OFF/);
    assert.match(flow.getScreen().text, /Not checked yet\./);
  });

  it('a new commit upstream: «Check now» offers it; the tap pulls, builds, self-checks and restarts the SAME process; the update says what it added', async () => {
    secondCommit = fixture.pushCommit(
      { 'CHANGELOG.md': addChangelogEntry('A flow entry of the update.'), 'src/bot.ts': (previous) => `${previous}\n// a change that rebuilds dist\n` },
      'feat: a flow entry',
    );
    await flow.checkNow(`${secondCommit} is out`);
    assert.ok(flow.getButtons().includes(`upd_go_${secondCommit}`));

    assert.equal(await flow.tap(`upd_go_${secondCommit}`), `⬆️ Updating to ${secondCommit} — installing as soon as no agent is working.`);
    await flow.waitForRestartInPlace('the bot to restart onto the new commit', updateTimeoutMs);
    assert.equal(fixture.getHead(), secondCommit, 'the checkout was fast-forwarded');
    assert.equal(getCharness().pid, runningPid, 'the same process');
    assert.equal(getProcessStartTicks(runningPid), runningStartTicks);

    const updated = await flow.waitForGeneralMessage('the "Updated" message', replyTimeoutMs, (message) => message.text.startsWith('🔄 Charness updated:'));
    assert.equal(updated.text, [`🔄 Charness updated: ${firstCommit} → ${secondCommit} (1 commits)`, '• A flow entry of the update.'].join('\n'));
    assert.equal(fakeTelegram.listPinnedMessageIds().includes(updated.message_id), false, 'nothing to do: not pinned');
    await general.sendAndAwaitReply('/update', `· git @ ${secondCommit}`);
  });

  it('a commit that does not compile is pulled, fails its build and the checkout goes back to the commit that ran: one line, the same process, never offered again', async () => {
    await flow.openScreen(`· git @ ${secondCommit}`);
    const brokenCommit = fixture.pushCommit({ 'src/bot.ts': (previous) => `${previous}\n${brokenLine}\n` }, 'fix: does not compile');
    await flow.checkNow(`${brokenCommit} is out`);
    const bootsBefore = flow.countBoots();
    await flow.tap(`upd_go_${brokenCommit}`);
    const failure = await flow.waitForGeneralMessage('the failure line', updateTimeoutMs, (message) => message.text.startsWith('⚠️ Automatic update to'));
    assert.equal(
      failure.text,
      [`⚠️ Automatic update to ${brokenCommit} failed: the install did not complete. Still running ${secondCommit}.`, `Update by hand: ${path.join(fixture.checkoutDir, 'scripts', 'self-update.sh')}`].join('\n'),
    );
    assert.equal(fixture.getHead(), secondCommit, 'put back on the commit that ran');
    assert.equal(flow.countBoots(), bootsBefore, 'the bot never restarted');
    assert.equal(getCharness().pid, runningPid);
    assert.ok(!fs.readFileSync(path.join(fixture.checkoutDir, 'src', 'bot.ts'), 'utf8').includes(brokenLine), 'the broken source is gone from the working tree');

    await flow.checkNow('up to date');
    assert.equal(flow.getButtons().some((data) => data.startsWith('upd_go_')), false, 'a commit that failed is not offered again');
  });

  it('a checkout with local changes is left alone and the screen says why; once they are gone the update is offered again', async () => {
    const fixCommit = fixture.pushCommit({ 'src/bot.ts': (previous) => previous.replace(`\n${brokenLine}\n`, '\n'), 'CHANGELOG.md': addChangelogEntry('The fix that follows.') }, 'fix: it compiles again');
    const licensePath = path.join(fixture.checkoutDir, 'LICENSE');
    fs.appendFileSync(licensePath, '\nlocal edit\n');
    await flow.checkNow('skipped: local changes in the checkout');
    assert.equal(flow.getButtons().some((data) => data.startsWith('upd_go_')), false);
    const refused = await general.sendAndAwaitReply('/update now', 'Nothing was updated');
    assert.equal(refused.text, 'ℹ️ Nothing was updated — skipped: local changes in the checkout', 'the typed «update now» names the reason instead of claiming it is up to date');
    assert.equal(fixture.getHead(), secondCommit, 'and pulled nothing');

    fixture.git('checkout', '--', 'LICENSE');
    await flow.checkNow(`${fixCommit} is out`);
    assert.ok(flow.getButtons().includes(`upd_go_${fixCommit}`));
  });

  it('a range that adds a MIGRATION_*.md is offered, not pulled by itself; its tap pulls it and the restart lists what the whole range added', async () => {
    const guideCommit = fixture.pushCommit({ 'MIGRATION_9_TO_10.md': '# Migrating\n' }, 'docs: a migration guide');
    await flow.checkNow(`${guideCommit} adds a migration guide — not pulled by itself`);
    assert.equal(fixture.getHead(), secondCommit, 'nothing was pulled');
    assert.ok(flow.getButtons().includes(`upd_go_${guideCommit}`));

    await flow.tap(`upd_go_${guideCommit}`);
    await flow.waitForRestartInPlace('the bot to restart onto the range with the guide', updateTimeoutMs);
    assert.equal(fixture.getHead(), guideCommit);
    assert.equal(getCharness().pid, runningPid, 'the same process');
    const updated = await flow.waitForGeneralMessage('the "Updated" message', replyTimeoutMs, (message) => message.text.includes(`→ ${guideCommit}`));
    assert.match(updated.text, /^🔄 Charness updated: [0-9a-f]{7} → [0-9a-f]{7} \(\d+ commits\)\n• The fix that follows\.$/);
  });
  it('a version that was booted twice without being confirmed is rolled back by its own next boot: the checkout goes back, the SAME process restarts onto it and takes the lock again, one line says so', async () => {
    const rolledBackFrom = fixture.getHead();
    await charness?.stop();
    // What two unconfirmed boots of the pulled range leave behind (each boot counts itself in before the bot module loads).
    writeUpdatePending(getLayout().dataDir, {
      kind: 'git',
      status: 'pending',
      from: { version: 'flow', commit: secondCommit },
      to: { version: 'flow', commit: rolledBackFrom },
      attempts: 2,
      isUserRequested: false,
    });
    await startCharness(updateTimeoutMs);

    assert.ok(getCharness().output.includes(`[update] flow did not start 2 times — going back to flow`), 'the boot decided the rollback');
    assert.equal(fixture.getHead(), secondCommit, 'the checkout is back on the commit that ran');
    const failure = await flow.waitForGeneralMessage('the failure line of the rolled-back version', replyTimeoutMs, (message) => message.text.includes(`failed: the new version kept failing to boot. Still running ${secondCommit}`));
    assert.match(failure.text, new RegExp(`^⚠️ Automatic update to ${rolledBackFrom} failed`));
    assert.equal(readUpdatePending(getLayout().dataDir), null, 'the marker is settled and gone');
    await flow.openScreen(`· git @ ${secondCommit}`);
  });
});
