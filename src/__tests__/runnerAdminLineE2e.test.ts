/**
 * @description The ADMIN pairing line at PROCESS level: `sudo sh -c '<checks>' sh '<pairing script>' <account>`, as `charness runners pair`
 * prints it, pasted into an ordinary shell. The hub is a loopback `sshd` plus a copy of the built charness, the runner machine a temp HOME
 * (`runnerLinkE2e/runnerLinkFlowKit.ts`), and what a flow cannot have is stood in for (`runnerAdminLineE2e/adminLineStandIns.ts`): `sudo`
 * (root through `fakeroot`; `sudo -u <account> -H` hands the command to the real user with the account's HOME), `id` / `getent` for the
 * stand-in accounts, and `loginctl` / `systemctl`. Everything else is real: the line's own sh, the download over ssh, the pairing, the
 * hub's redemption, and the runner utility's own `service install --system --user`. In order, on the state the step before left:
 *
 *   no sudo → refused; an account that does not exist, an admin account, root, a name edited into something that is no account name →
 *   each refused BEFORE anything runs as that account, nothing is paired, nothing is written to any account, and the code stays unspent
 *   → the same code, with a standard account: paired AS that account (its HOME holds the runner's state), the pairing says the service
 *   follows instead of printing the «keep it running» help, and then — only then — the service is installed for the account: lingering,
 *   the user manager awaited, the install run as the account (its units and its service record are in ITS home)
 *   → the line used again is refused by the hub and installs nothing
 *   → a service manager that fails: the account stays paired, the line exits with a failure and names the command to run again
 *
 * Needs sshd, ssh, ssh-keyscan, rsync, Pueue, tar, fakeroot and the built CLI (`yarn build`): a local run without them is SKIPPED with the
 * reason, CI fails without. No registry and no download is used. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { testNodeModulesEnvName } from '../runnerUtility/appInstall';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { getServiceNames } from '../runnerUtility/serviceUnits';
import { installAdminStandIns, readStandInCalls, type AdminStandIns } from './runnerAdminLineE2e/adminLineStandIns';
import {
  createExtraMachine,
  createRunnerLinkLayout,
  destroyRunnerLinkLayout,
  getMissingTools,
  isCi,
  makePairingLines,
  readJson,
  type RunnerLinkLayout,
} from './runnerLinkE2e/runnerLinkFlowKit';

const repoRoot = path.resolve(__dirname, '..', '..');
const missingTools = [...getMissingTools(), ...(spawnSync('which', ['fakeroot'], { stdio: 'ignore' }).status === 0 ? [] : ['fakeroot'])];
const skipReason = missingTools.length > 0 && !isCi ? `missing: ${missingTools.join(', ')}` : false;
const lineTimeoutMs = 180_000;
const standardAccountUid = 4242;
const adminAccountUid = 4243;

describe('the admin pairing line (process level)', { skip: skipReason }, () => {
  let layout: RunnerLinkLayout;
  let standIns: AdminStandIns;
  let adminLine = '';
  let runnerHome = '';
  let failingHome = '';
  let bossHome = '';

  before(async () => {
    assert.deepEqual(missingTools, [], 'CI installs everything this flow needs');
    layout = await createRunnerLinkLayout();
    runnerHome = createExtraMachine(layout, 'acct-runner');
    failingHome = createExtraMachine(layout, 'acct-runner2');
    bossHome = createExtraMachine(layout, 'acct-boss');
    standIns = installAdminStandIns(layout.root, [
      { name: 'runner', uid: standardAccountUid, groups: ['runner', 'users'], homeDir: runnerHome },
      { name: 'runner2', uid: standardAccountUid + 1, groups: ['runner2', 'users'], homeDir: failingHome },
      { name: 'boss', uid: adminAccountUid, groups: ['boss', 'users', 'sudo'], homeDir: bossHome },
      { name: 'rootish', uid: 0, groups: ['root'], homeDir: bossHome },
    ]);
    ({ adminLine } = makePairingLines(layout, 'runner'));
  });
  after(async () => {
    await destroyRunnerLinkLayout(layout);
  });

  /** The line pasted into an ordinary shell with the stand-ins first on PATH, as the operator's terminal would have it. */
  function pasteLine(line: string): SpawnSyncReturns<string> {
    return spawnSync('sh', ['-c', line], {
      encoding: 'utf8',
      timeout: lineTimeoutMs,
      env: {
        HOME: path.join(layout.root, 'admin-home'),
        PATH: `${standIns.binDir}:${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        TMPDIR: path.join(layout.root, 'tmp'),
        LANG: 'C.UTF-8',
        [testNodeModulesEnvName]: path.join(repoRoot, 'node_modules'),
      },
    });
  }

  /** The line as the operator edits it: the last word is the account. */
  function withAccount(line: string, account: string): string {
    return `${line.slice(0, line.lastIndexOf(' ') + 1)}${account}`;
  }

  /** The hub writes `paired.json` at the first pairing: before it there is no runner and no file. */
  function readHubRunners(): Array<{ id: string; name: string }> {
    const pairedPath = path.join(layout.hubDir, 'paired.json');
    return fs.existsSync(pairedPath) ? readJson<{ runners: Array<{ id: string; name: string }> }>(pairedPath).runners : [];
  }

  function countOpenCodes(): number {
    return readJson<{ pending: unknown[] }>(path.join(layout.hubDir, 'pending.json')).pending.length;
  }

  /** Nothing of a runner is in the account: no config, no keys. */
  function assertNothingPairedIn(home: string): void {
    assert.equal(fs.existsSync(getRunnerHomePaths(home).config), false, `${home} holds a runner's config`);
    assert.equal(fs.existsSync(getRunnerHomePaths(home).keysDir), false, `${home} holds keys`);
  }

  function assertRefusedBeforeAnything(result: SpawnSyncReturns<string>, message: RegExp): void {
    assert.notEqual(result.status, 0, `${result.stderr}${result.stdout}`);
    assert.match(result.stderr, message);
    assert.equal(readHubRunners().length, 0, 'nothing is paired');
    assert.equal(countOpenCodes(), 1, 'and the code is unspent');
    assert.ok(!readStandInCalls(standIns).some((call) => call.startsWith('sudo -u') || call.startsWith('loginctl') || call.startsWith('systemctl')), 'nothing ran as an account, nothing was asked of a service manager');
    for (const home of [runnerHome, failingHome, bossHome]) assertNothingPairedIn(home);
  }

  it('refuses to run without sudo, before anything else', () => {
    // Pasted without its leading `sudo`, in a shell whose `id` says what a normal user is.
    assertRefusedBeforeAnything(pasteLine(adminLine.replace(/^sudo /, '')), /run this line with sudo/);
  });

  it('stops on an account that does not exist — names it, creates nothing, pairs nothing', () => {
    assertRefusedBeforeAnything(pasteLine(withAccount(adminLine, 'ghost')), /no account ghost here: create a standard user, or end the line with the right name/);
  });

  it('refuses an admin account and root', () => {
    assertRefusedBeforeAnything(pasteLine(withAccount(adminLine, 'boss')), /boss is an admin account: the agents code would run with its rights/);
    assertRefusedBeforeAnything(pasteLine(withAccount(adminLine, 'rootish')), /rootish is root: use a standard user/);
  });

  it('refuses a name that is not an account name, and runs nothing from it', () => {
    const marker = path.join(layout.root, 'pwned');
    for (const edited of ['x;y', `$(touch ${marker})`, `runner;touch ${marker}`, '-n']) {
      assertRefusedBeforeAnything(pasteLine(`${adminLine.slice(0, adminLine.lastIndexOf(' ') + 1)}'${edited}'`), /is not an account name/);
    }
    assert.equal(fs.existsSync(marker), false, 'nothing in the name was executed');
  });

  it('pairs AS the account, says the service follows, and then installs the service for it — in its home, through lingering and the account\'s own install', () => {
    const result = pasteLine(adminLine);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, new RegExp(`Paired with charness @ExampleBot \\(127\\.0\\.0\\.1:${layout.sshPort}\\) as runner “`));
    assert.match(result.stdout, /Keeping it running: the always-on service for this account is installed next, by the same line\./);
    assert.doesNotMatch(result.stdout, /Keep it running:/, 'the commands of the plain line\'s help would be wrong here');
    assert.match(result.stdout, /Installed two user services: charness-runner-[0-9a-f]{8}\.service \(the link\) and charness-runner-pueued-[0-9a-f]{8}\.service \(the queue\)\./);
    assert.match(result.stdout, /Lingering is on: they run without a login and start at boot\./);

    // Paired as the account: its home holds the runner, the hub knows one runner.
    const paths = getRunnerHomePaths(runnerHome);
    assert.equal(readJson<{ hub: { label: string } }>(paths.config).hub.label, '@ExampleBot');
    assert.equal(fs.existsSync(paths.clientKey), true);
    assert.equal(readHubRunners().length, 1);
    assert.equal(countOpenCodes(), 0, 'the code is spent');

    // The service is the account\'s: units and record in its home, none in anybody else\'s.
    const names = getServiceNames(paths.root);
    const unitDir = path.join(runnerHome, '.config', 'systemd', 'user');
    assert.equal(fs.existsSync(path.join(unitDir, names.systemdLink)), true);
    assert.equal(fs.existsSync(path.join(unitDir, names.systemdPueued)), true);
    assert.equal(fs.readFileSync(paths.serviceMarker, 'utf8').trim(), 'user-service');
    for (const home of [failingHome, bossHome]) assertNothingPairedIn(home);

    // The order of the whole line: the account\'s home asked for, the pairing as the account, lingering (as root), the user manager
    // awaited, the install run AS the account, the units reloaded and enabled by the account.
    const calls = readStandInCalls(standIns);
    const indexOf = (prefix: string, from = 0): number => calls.findIndex((call, index) => index >= from && call.startsWith(prefix));
    const asRunner = 'sudo -u runner -H';
    const homeAsked = indexOf(asRunner);
    const pairingRun = indexOf(asRunner, homeAsked + 1);
    const lingering = indexOf('loginctl enable-linger runner');
    const managerAwaited = indexOf(`${asRunner} env XDG_RUNTIME_DIR=/run/user/${standardAccountUid} systemctl --user is-system-running`);
    const installRun = indexOf(`${asRunner} env XDG_RUNTIME_DIR=/run/user/${standardAccountUid} ${paths.launcher} service install`);
    const reloaded = indexOf('systemctl --user daemon-reload');
    assert.ok(homeAsked >= 0 && pairingRun > homeAsked && lingering > pairingRun && managerAwaited > lingering && installRun > managerAwaited && reloaded > installRun, calls.join('\n'));
    assert.equal(calls.filter((call) => call.startsWith('loginctl enable-linger')).length, 1);
  });

  it('the line used again is refused by the hub and installs nothing more', () => {
    const callsBefore = readStandInCalls(standIns).length;
    const again = pasteLine(adminLine);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /this account is already paired|the hub refused or did not answer/);
    assert.equal(readHubRunners().length, 1);
    assert.ok(!readStandInCalls(standIns).slice(callsBefore).some((call) => call.startsWith('loginctl enable-linger')), 'no service was installed by the failed run');
  });

  it('a service manager that fails leaves the account paired, exits with a failure and names the command to run again', () => {
    fs.writeFileSync(standIns.failReloadFlag, '');
    const { adminLine: secondLine } = makePairingLines(layout, 'runner2');
    const result = pasteLine(secondLine);
    assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Paired with charness @ExampleBot/, 'the pairing itself went through');
    assert.match(result.stdout, /systemctl --user cannot reach a user session/);
    const paths = getRunnerHomePaths(failingHome);
    assert.match(result.stdout, new RegExp(`The runner is paired, but its service is not installed\\. After fixing this run: sudo ${paths.launcher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} service install --system --user runner2`));
    assert.equal(fs.existsSync(paths.config), true, 'the account stays paired');
    assert.equal(fs.existsSync(path.join(failingHome, '.config', 'systemd', 'user', getServiceNames(paths.root).systemdLink)), false, 'and nothing is left of a half-installed service');
    assert.equal(readHubRunners().length, 2);
    fs.rmSync(standIns.failReloadFlag, { force: true });
  });
});
