/**
 * @description The ADMIN pairing line at PROCESS level: `sudo sh -c '<script>' sh <account>`, as `charness runners pair` prints it, pasted
 * into an ordinary shell. The hub is a loopback `sshd` plus a copy of the built charness, the runner machine a temp HOME
 * (`runnerLinkE2e/runnerLinkFlowKit.ts`), and what a flow cannot have is stood in for (`runnerAdminLineE2e/adminLineStandIns.ts`): `sudo`
 * (root through `fakeroot`; `sudo -u <account> -H` hands the command to the real user with the account's HOME), `id` / `getent` for the
 * stand-in accounts, and `loginctl` / `systemctl`. Everything else is real: the line's own sh, root's download of the package over ssh into
 * a folder of its own, the account's pairing from that copy, the hub's redemption, and the root step — `rootServiceCli.js`, run from the
 * root-owned copy, which has no `node_modules` (so the step must need none) — with the account's own `service install`. In order, on the
 * state the step before left:
 *
 *   no sudo → refused; an account that does not exist, an admin account, root, a name edited into something that is no account name →
 *   each refused BEFORE anything is fetched or runs as that account, nothing is paired, nothing is written to any account, and the code
 *   stays unspent
 *   → the same code, with a standard account: paired AS that account, from the copy root made (its HOME holds the runner's state), the pairing
 *   says the service follows instead of printing the «keep it running» help, and then — only then — the service is installed for the
 *   account: lingering, the user manager awaited, the install run as the account (its units and its service record are in ITS home).
 *   Meanwhile the account has swapped its launcher for a trap that fires when ROOT starts it: it never does
 *   → the line used again is refused by the hub and installs nothing
 *   → a service manager that fails: the account stays paired, the line exits with a failure and says what to do; a fresh line then finds the
 *   account paired, pairs nothing twice, CLOSES its own code on the hub (the gate's `cancel`) and installs the service
 *
 * The machine has NO Node.js the line may use: the folder of the Node running the flow is left off the line's PATH, and the package's REAL
 * `remoteRun/ensureNode.sh` (run in `root` mode with this flow's own shared folder and a local mirror of nodejs.org, a copy of the Node running the flow,
 * as its test seams) installs the runner its own, checks it the way root requires, and everything — the root step, the account's pairing, its
 * launcher — runs on that one. The retry then finds it already there.
 *
 * Needs sshd, ssh, ssh-keyscan, rsync, Pueue, tar, fakeroot and the built CLI (`yarn build`): a local run without them is SKIPPED with the
 * reason, CI fails without. No registry and no network is used. Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { npmInstallArgs } from '../runnerUtility/appInstall';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { getServiceNames } from '../runnerUtility/serviceUnits';
import { installAdminStandIns, readNpmStandInCalls, readStandInCalls, readStandInIsolation, renderNpmStandIn, type AdminStandIns } from './runnerAdminLineE2e/adminLineStandIns';
import { mirrorRelease, writeNodeMirror } from './nodeMirrorKit';
import {
  createExtraMachine,
  createRunnerLinkLayout,
  destroyRunnerLinkLayout,
  getMissingTools,
  isCi,
  makePairingLines,
  placeRootNodeInstallerWrapper,
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
  /** Where the line's Node install puts the runner's Node in this flow (the real one is `/usr/local/lib/charness-runner/node`, which a flow cannot write). */
  let sharedNodeBase = '';
  /** Where the stand-in npm of the installed Node records its runs. */
  let npmRecordPath = '';

  before(async () => {
    assert.deepEqual(missingTools, [], 'CI installs everything this flow needs');
    layout = await createRunnerLinkLayout();
    sharedNodeBase = path.join(layout.root, 'shared-node');
    // The mirror of nodejs.org holds a copy of the Node running this flow: the runner is paired and its service installed on a Node that was DOWNLOADED, not found.
    // …and a stand-in `npm` beside its `node` (no registry here), a `#!/usr/bin/env node` script like the real one: the install of the runner program starts it for real.
    npmRecordPath = path.join(layout.root, 'npm-calls.jsonl');
    const distDir = writeNodeMirror(path.join(layout.root, 'node-dist'), path.join(layout.root, 'node-stage'), { nodeFrom: process.execPath, npmScript: renderNpmStandIn(path.join(repoRoot, 'node_modules'), npmRecordPath) });
    placeRootNodeInstallerWrapper(layout, { base: sharedNodeBase, distDir });
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
        // No Node.js for the line to find: not the one running this flow, nor a copy of it.
        PATH: [standIns.binDir, ...(process.env.PATH ?? '').split(path.delimiter).filter((folder) => folder !== path.dirname(process.execPath))].join(path.delimiter),
        TMPDIR: path.join(layout.root, 'tmp'),
        LANG: 'C.UTF-8',
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
    assertRefusedBeforeAnything(pasteLine(withAccount(adminLine, 'ghost')), /no account ghost here: create a standard user or fix the last word/);
  });

  it('refuses an admin account and root', () => {
    assertRefusedBeforeAnything(pasteLine(withAccount(adminLine, 'boss')), /boss is an admin: the agents code runs with its rights/);
    assertRefusedBeforeAnything(pasteLine(withAccount(adminLine, 'rootish')), /rootish is root: use a standard user/);
  });

  it('refuses a name that is not an account name, and runs nothing from it', () => {
    const marker = path.join(layout.root, 'pwned');
    for (const edited of ['x;y', `$(touch ${marker})`, `runner;touch ${marker}`, '-n']) {
      assertRefusedBeforeAnything(pasteLine(`${adminLine.slice(0, adminLine.lastIndexOf(' ') + 1)}'${edited}'`), /is not an account name/);
    }
    assert.equal(fs.existsSync(marker), false, 'nothing in the name was executed');
  });

  it('pairs AS the account from root\'s own copy, says the service follows, then installs the service for it — in its home, through lingering and the account\'s own install — and root never starts anything of the account\'s', () => {
    const result = pasteLine(adminLine);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, new RegExp(`Paired with charness @ExampleBot \\(127\\.0\\.0\\.1:${layout.sshPort}\\) as runner “`));
    assert.match(result.stdout, /Keeping it running: the always-on service for this account is installed next, by the same line\./);
    assert.doesNotMatch(result.stdout, /Keep it running:/, 'the commands of the plain line\'s help would be wrong here');
    // Each step is told as it happens (stdout is a pipe here: one plain line per step) — the shell's own first, then the runner utility's, the root step's last.
    const stepPositions = ['checking the account runner', 'downloading the package from the hub', 'installing the runner program', 'checking this machine', 'pairing with the hub', 'getting Pueue', 'finding rsync', 'installing the always-on service for runner']
      .map((step) => result.stdout.indexOf(`charness-runner: ${step}`));
    assert.ok(stepPositions.every((position) => position >= 0), `a step line is missing: ${result.stdout}`);
    assert.deepEqual([...stepPositions].sort((left, right) => left - right), stepPositions, 'the steps are told in the order they happen');
    assert.match(result.stdout, /Installed two user services: charness-runner-[0-9a-f]{8}\.service \(the link\) and charness-runner-pueued-[0-9a-f]{8}\.service \(the queue\)\./);
    assert.match(result.stdout, /Lingering is on: they run without a login and start at boot\./);

    // Paired as the account: its home holds the runner, the hub knows one runner.
    const paths = getRunnerHomePaths(runnerHome);
    assert.equal(readJson<{ hub: { label: string } }>(paths.config).hub.label, '@ExampleBot');
    assert.equal(fs.existsSync(paths.clientKey), true);
    assert.equal(readHubRunners().length, 1);
    assert.equal(countOpenCodes(), 0, 'the code is spent');

    // The service is the account's: units and record in its home, none in anybody else's.
    const names = getServiceNames(paths.root);
    const unitDir = path.join(runnerHome, '.config', 'systemd', 'user');
    assert.equal(fs.existsSync(path.join(unitDir, names.systemdLink)), true);
    assert.equal(fs.existsSync(path.join(unitDir, names.systemdPueued)), true);
    assert.equal(fs.readFileSync(paths.serviceMarker, 'utf8').trim(), 'user-service');
    for (const home of [failingHome, bossHome]) assertNothingPairedIn(home);

    // Root never ran the account's launcher (the trap the account put there after its pairing would have fired); the account's own
    // steps did run through it.
    assert.equal(fs.existsSync(standIns.trapFile), false, 'root started something of the account\'s');
    assert.equal(fs.existsSync(`${paths.launcher}.real`), true, 'the trap was put in place after the pairing');

    // The order of the whole line: the pairing as the account from root's copy in /tmp, lingering (as root), the user manager awaited,
    // the install run AS the account through its launcher, the units reloaded and enabled by the account.
    const calls = readStandInCalls(standIns);
    const indexOf = (prefix: string, from = 0): number => calls.findIndex((call, index) => index >= from && call.startsWith(prefix));
    const asRunner = 'sudo -u runner -H';
    const pairingRun = calls.findIndex((call) => call.startsWith(asRunner) && call.includes('runnerCli.js pair'));
    assert.match(calls[pairingRun], new RegExp(`^${asRunner.replace(/[-]/g, '\\-')} \\S+/node /tmp/charness-runner\\.[A-Za-z0-9]{8}/pkg/dist/runnerUtility/runnerCli\\.js pair\\b`), 'the account pairs from the copy root made');
    // The Node everything runs under is the one the line INSTALLED for the runner (the machine had none to offer): downloaded from the mirror, verified,
    // in the shared folder — and the account's launcher (what its service starts) names that one: the service depends on no home and on no package manager.
    const managedNode = path.join(fs.realpathSync(sharedNodeBase), mirrorRelease, 'bin', 'node');
    assert.equal(fs.existsSync(managedNode), true, 'the Node was installed');
    assert.match(result.stderr, new RegExp(`^charness-runner: installing Node\\.js ${mirrorRelease.replace(/\./g, '\\.')} for the runner into \\S+/shared-node/${mirrorRelease.replace(/\./g, '\\.')} \\(the official build from nodejs\\.org, checksum checked\\)$`, 'm'));
    assert.ok(calls[pairingRun].startsWith(`${asRunner} ${managedNode} `), `the pairing ran under ${managedNode}: ${calls[pairingRun]}`);
    assert.ok(fs.readFileSync(paths.launcher, 'utf8').includes(`NODE='${managedNode}'`) || fs.readFileSync(`${paths.launcher}.real`, 'utf8').includes(`NODE='${managedNode}'`), 'the launcher starts the runner\'s own Node');
    // The install of the runner program started npm for real — the one beside that Node, a `#!/usr/bin/env node` script, on a machine whose PATH (the line's, and the one
    // a real `sudo -u` hands the account) holds no Node. It ran under the runner's own Node, which the install put first on the PATH npm got.
    const npmCalls = readNpmStandInCalls(npmRecordPath);
    assert.equal(npmCalls.length, 1, 'npm ran once, for the one pairing');
    assert.deepEqual(npmCalls[0].args, [...npmInstallArgs], 'as `npm ci`, the lock\'s exact versions');
    assert.equal(npmCalls[0].node, managedNode, 'under the Node the line installed — `env` found that one');
    assert.ok(npmCalls[0].path.startsWith(`${path.dirname(managedNode)}${path.delimiter}`), `the runner's Node is the first folder of npm's PATH: ${npmCalls[0].path}`);
    assert.equal(fs.realpathSync(path.dirname(npmCalls[0].cwd)), fs.realpathSync(paths.root), 'in a new app folder of the account\'s state folder');
    const lingering = indexOf('loginctl enable-linger runner');
    const managerAwaited = indexOf(`${asRunner} env XDG_RUNTIME_DIR=/run/user/${standardAccountUid} systemctl --user is-system-running`);
    const installRun = indexOf(`${asRunner} env XDG_RUNTIME_DIR=/run/user/${standardAccountUid} ${paths.launcher} service install`);
    const reloaded = indexOf('systemctl --user daemon-reload');
    assert.ok(pairingRun >= 0 && lingering > pairingRun && managerAwaited > lingering && installRun > managerAwaited && reloaded > installRun, calls.join('\n'));
    assert.equal(calls.filter((call) => call.startsWith('loginctl enable-linger')).length, 1);
    assert.equal(calls.filter((call) => call.startsWith(`${asRunner} `) && call.includes('runnerCli.js pair')).length, 1, 'the account was paired once');

    // Nothing the account runs has the admin's terminal: each call the ROOT STEP makes started with /dev/null for input, as the head of a session of its
    // own — no controlling terminal, whatever terminal the line was pasted in. The calls the Node install (a plain script) makes as the account are
    // probes — `test -x` and `test -w` — that execute nothing of the account's.
    const lines = readStandInIsolation(standIns);
    const isProbeOfPick = (line: string): boolean => /^stdin=\S+ leader=no terminal=\S+ test -[xw] /.test(line);
    const probes = lines.filter(isProbeOfPick);
    const isolation = lines.filter((line) => !isProbeOfPick(line));
    const escapedNode = managedNode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.ok(probes.some((line) => new RegExp(` test -x ${escapedNode}$`).test(line)), 'the install asked whether the account may run the Node');
    assert.ok(probes.some((line) => new RegExp(` test -w ${escapedNode}$`).test(line)) && probes.some((line) => new RegExp(` test -w ${path.dirname(escapedNode)}$`).test(line)), 'and whether it can write the Node or its folder');
    assert.ok(probes.every((line) => / test -[xw] \/\S+$/.test(line)), 'and asked nothing else');
    assert.ok(isolation.some((line) => line.includes('runnerCli.js pair')), 'the pairing among them — it was the shell\'s own `sudo -u` before');
    assert.ok(isolation.some((line) => line.includes('is-system-running')) && isolation.some((line) => line.includes('service install')), 'and the user manager and the install');
    assert.ok(isolation.some((line) => / test -w \/\S+$/.test(line)), 'and the root step\'s own look at the Node, as the account');
    assert.ok(isolation.some((line) => / test -r \/\S+ -a -x \/\S+$/.test(line)) || !fs.existsSync('/home'), 'and the look at the homes of other users that the account can read, as the account');
    for (const line of isolation) {
      assert.match(line, /^stdin=\/dev\/null leader=yes terminal=\?{1,2} /, line);
    }
  });

  it('the line used again is refused by the hub and installs nothing more', () => {
    const callsBefore = readStandInCalls(standIns).length;
    const again = pasteLine(adminLine);
    assert.notEqual(again.status, 0);
    // The refusal is the HUB's, at the download: a spent code's key is gone, so the line stops before the account or any service is asked.
    assert.match(again.stderr, /^charness-runner: the hub refused or did not answer: expired or used line\? see the ssh message above/m);
    assert.doesNotMatch(`${again.stdout}${again.stderr}`, /already paired|Paired with/);
    assert.equal(readHubRunners().length, 1);
    assert.ok(!readStandInCalls(standIns).slice(callsBefore).some((call) => call.startsWith('loginctl enable-linger')), 'no service was installed by the failed run');
  });

  it('a service manager that fails leaves the account paired, exits with a failure and says what to do — a fresh line then pairs nothing twice and installs the service', () => {
    fs.writeFileSync(standIns.failReloadFlag, '');
    const { adminLine: secondLine } = makePairingLines(layout, 'runner2');
    const result = pasteLine(secondLine);
    assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Paired with charness @ExampleBot/, 'the pairing itself went through');
    assert.match(result.stderr, new RegExp(`^charness-runner: Node\\.js ${mirrorRelease.replace(/\./g, '\\.')} for the runner is already in \\S+/shared-node/${mirrorRelease.replace(/\./g, '\\.')}$`, 'm'), 'the second account\'s line found the Node the first one installed and downloaded nothing');
    assert.doesNotMatch(result.stderr, /installing Node\.js/);
    assert.match(result.stderr, /systemctl --user cannot reach a user session/);
    assert.match(result.stderr, /^charness-runner: runner2 is paired, but has no service: fix the above and paste a fresh admin line$/m);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /sudo [^\n]*service install/, 'no command that has root run the account\'s program is offered');
    const paths = getRunnerHomePaths(failingHome);
    assert.equal(fs.existsSync(paths.config), true, 'the account stays paired');
    assert.equal(fs.existsSync(path.join(failingHome, '.config', 'systemd', 'user', getServiceNames(paths.root).systemdLink)), false, 'and nothing is left of a half-installed service');
    assert.equal(readHubRunners().length, 2);
    assert.equal(fs.existsSync(standIns.trapFile), false);

    // The service manager is mended; a FRESH admin line is the retry.
    fs.rmSync(standIns.failReloadFlag, { force: true });
    const { adminLine: retryLine } = makePairingLines(layout, 'runner2');
    assert.equal(countOpenCodes(), 1, 'the retry\'s code is open until the line closes it');
    const retried = pasteLine(retryLine);
    assert.equal(retried.status, 0, `${retried.stderr}\n${retried.stdout}`);
    assert.match(retried.stdout, /This account is already paired \(as “[^”]+” with @ExampleBot\): it is not paired again\. Its always-on service is installed next, by the same line\./);
    assert.match(retried.stdout, /Installed two user services:/);
    assert.equal(readHubRunners().length, 2, 'nothing was paired twice');
    assert.equal(countOpenCodes(), 0, 'and the retry\'s code is closed on the hub, not left open (and logged by sudo) until it runs out');
    // …with a trace, so the Telegram messages and `--wait` can tell it from a code that ran out (and say the line did its job).
    assert.equal(readJson<{ closed: unknown[] }>(path.join(layout.hubDir, 'closed.json')).closed.length, 1);
    assert.equal(fs.existsSync(path.join(failingHome, '.config', 'systemd', 'user', getServiceNames(paths.root).systemdLink)), true);
    assert.equal(fs.existsSync(standIns.trapFile), false, 'and root still started nothing of the account\'s');
  });
});
