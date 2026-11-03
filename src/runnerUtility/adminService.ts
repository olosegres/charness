import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getOutputTail } from '../selfUpdate/commandRunner';
import {
  commandTimeoutMs,
  fail,
  getLaunchdFiles,
  installLaunchdJobs,
  parseSystemStepAnswer,
  resolveLinuxAccount,
  resolveMacAccount,
  rootUid,
  type ServiceResult,
  type TargetAccount,
} from './serviceCommon';
import { findHomeContaining, findReadableHomes, formatReadableHomesWarning, listSubfolders } from './homeFolders';
import { runCommandIsolated, type IsolatedCommandRunner } from './isolatedCommand';
import { serviceFollowsFlag } from './pairArgs';
import { getRunnerHomePaths } from './runnerHome';
import { getServiceNames, planLaunchdJobs, renderLaunchdPlist } from './serviceUnits';

/**
 * @description The ROOT step of the admin pairing line: install the always-on service of a runner account that the line has just paired.
 * It runs from a root-owned copy of the package (`rootServiceCli.ts`, which has no dependencies — hence Node built-ins only here), never
 * from the account's files: the account runs the agents' code, so root must not exec, read through or write into anything the account can
 * change. Everything of the account's — Pueue, its configuration, the service record, the user service's own units — is therefore done by
 * the account's OWN program run AS the account (`sudo -u <account> -H`); root only
 *
 *   macOS   writes the two LaunchDaemon definitions into `/Library/LaunchDaemons` (a folder only root can write), `chown`s them with
 *           `lchown`, and calls `launchctl`. The definitions are rendered here from the account's name and home alone — the account's
 *           answer to `system-step prepare` decides nothing about their text — and they run as the account (`UserName`), with no extra rights
 *   Linux   switches lingering on for the account (`loginctl enable-linger`), waits for its user manager, and has the account install its
 *           own user service — the same install it would run itself
 *
 * An account's tree is read by nobody here, so a planted link in it reaches nothing of root's.
 *
 * Everything that runs AS the account — the pairing (`pairAccountFromPackage`), its preparation, its service install, its user manager — goes
 * through ONE runner with no terminal attached (`isolatedCommand.ts`): a session of its own, no standard input, the output piped through this
 * process with its control characters stripped. The account runs the agents' code, and code it can change must not get the admin's terminal.
 */

/** The install run as the account starts two services and may wait for each. */
const installAsAccountTimeoutMs = 120 * 1000;
/** After `enable-linger` the user manager takes a moment to come up: it is asked once a second, for this many tries. */
const userManagerPollMs = 1000;
const userManagerPollAttempts = 20;
/** What `systemctl --user is-system-running` prints once the manager can take units (`degraded`: up, with some unit failed). */
const userManagerReadyStates: readonly string[] = ['running', 'degraded'];
const freshLineText = 'paste a fresh admin line from /runners (it finds the account paired and only installs the service)';

/** The pairing may download Pueue and build rsync from source: a long step, under its own deadline. */
const pairAsAccountTimeoutMs = 30 * 60 * 1000;

/** What the admin line hands over for the pairing of the account: the unpacked package, the archive it came in with the id the hub announced for it, and the code. */
export interface PairRequest {
  bootstrapDir: string;
  archivePath: string;
  packageId: string;
  code: string;
}

export interface AdminServiceDeps {
  /** Runs everything of the account's with no terminal (see the head of the file); a test's own stand-in. */
  runner: IsolatedCommandRunner;
  /** What the account's steps print as they go, already stripped of control characters (`stdout` / `stderr` of this process). */
  write: (stream: 'stdout' | 'stderr', text: string) => void;
  /** The `node` that runs this step and, as the account, its pairing: root's own copy of the package is run with it. */
  nodePath: string;
  /** The account's pairing program in the root-owned copy of the package, next to this step's own file. */
  runnerCliPath: string;
  platform: NodeJS.Platform;
  /** The uid of this process: the step is root's. */
  uid: number;
  /** The folder of the `node` that runs this step: the daemons' `PATH` starts with it, like the account's own services. */
  nodeDir: string;
  /** Where LaunchDaemons live (`/Library/LaunchDaemons`; a test's own folder). */
  launchDaemonsDir: string;
  /** Give a definition to root:wheel without following a link (`fs.lchownSync`; a test is not root). */
  giveToRoot: (filePath: string, uid: number, gid: number) => void;
  /** Who the account is, from the passwd database (never from the account's files); `null` when there is no such account. */
  resolveAccount: (name: string) => Promise<TargetAccount | null>;
  /** Wait between two looks at a starting user manager (a test does not wait). */
  sleep: (ms: number) => Promise<void>;
  /** The sub-folders of a folder (`/Users`, `/home`), for the look at the homes the account can read; a test's own. */
  listFolders: (parent: string) => string[];
}

export function createAdminServiceDeps(): AdminServiceDeps {
  return {
    runner: runCommandIsolated,
    write: (stream, text) => { (stream === 'stdout' ? process.stdout : process.stderr).write(text); },
    nodePath: process.execPath,
    runnerCliPath: path.join(__dirname, 'runnerCli.js'),
    platform: process.platform,
    uid: os.userInfo().uid,
    nodeDir: path.dirname(process.execPath),
    launchDaemonsDir: '/Library/LaunchDaemons',
    giveToRoot: fs.lchownSync,
    resolveAccount: (name) => (process.platform === 'darwin' ? resolveMacAccount(name, runCommandIsolated) : resolveLinuxAccount(name, runCommandIsolated)),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    listFolders: listSubfolders,
  };
}

/** The arguments of `sudo` that run the account's own launcher AS the account. */
function asAccountArgs(account: TargetAccount): string[] {
  return ['-u', account.name, '-H'];
}

async function installDaemons(account: TargetAccount, deps: AdminServiceDeps): Promise<ServiceResult> {
  const paths = getRunnerHomePaths(account.homeDir);
  const stepArgs = (step: 'prepare' | 'abandon'): string[] => [...asAccountArgs(account), paths.launcher, 'service', 'system-step', step];
  const prepared = await deps.runner('sudo', stepArgs('prepare'), { timeoutMs: installAsAccountTimeoutMs });
  const answer = parseSystemStepAnswer(prepared.stdout);
  if (answer === null) return fail(`The account ${account.name} gave no answer to its preparation (${getOutputTail(prepared, 2) || 'no output'}).`);
  if (!answer.ok) return fail(...answer.lines);
  const names = getServiceNames(paths.root);
  const accountJobs = planLaunchdJobs(paths, names, account.name, deps.nodeDir, account.name);
  const result = await installLaunchdJobs({
    runner: deps.runner,
    domain: 'system',
    files: getLaunchdFiles(true, account.homeDir, names, deps.launchDaemonsDir),
    names,
    jobs: accountJobs,
    hadService: answer.hadService,
    isLogDirMade: false,
    giveToRoot: deps.giveToRoot,
    forgetFirstInstall: async () => { await deps.runner('sudo', stepArgs('abandon'), { timeoutMs: commandTimeoutMs }); },
    retryText: freshLineText,
    render: renderLaunchdPlist,
  });
  if (!result.ok) return result;
  return { ok: true, lines: [`Installed two LaunchDaemons (${names.launchdLink}, ${names.launchdPueued}) that run as ${account.name}: always on, also logged out.`] };
}

async function installUserServiceFor(account: TargetAccount, deps: AdminServiceDeps): Promise<ServiceResult> {
  const paths = getRunnerHomePaths(account.homeDir);
  const asAccount = [...asAccountArgs(account), 'env', `XDG_RUNTIME_DIR=/run/user/${account.uid}`];
  const linger = await deps.runner('loginctl', ['enable-linger', account.name], { timeoutMs: commandTimeoutMs });
  if (!linger.ok) return fail(`\`loginctl enable-linger ${account.name}\` failed: ${getOutputTail(linger, 1) || 'no answer'}`);
  for (let attempt = 1; attempt <= userManagerPollAttempts; attempt += 1) {
    const state = await deps.runner('sudo', [...asAccount, 'systemctl', '--user', 'is-system-running'], { timeoutMs: commandTimeoutMs });
    if (userManagerReadyStates.includes(state.stdout.trim())) break;
    if (attempt === userManagerPollAttempts) return fail(`The user manager of ${account.name} did not come up within ${(userManagerPollAttempts * userManagerPollMs) / 1000} s after lingering was switched on.`);
    await deps.sleep(userManagerPollMs);
  }
  const installed = await deps.runner('sudo', [...asAccount, paths.launcher, 'service', 'install'], { timeoutMs: installAsAccountTimeoutMs });
  const lines = installed.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (installed.ok) return { ok: true, lines };
  return fail(...lines, ...(lines.length === 0 ? [getOutputTail(installed) || 'the install gave no output'] : []));
}

/** The account a root step serves, or why it cannot be served: a platform with a service manager, root running it, an existing standard account. */
async function resolveServedAccount(accountName: string, deps: AdminServiceDeps): Promise<TargetAccount | ServiceResult> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') return fail(`Services are supported on Linux (systemd) and macOS (launchd), not on ${deps.platform}.`);
  if (deps.uid !== rootUid) return fail('This step is root\'s: it is started by the admin pairing line from /runners, which asks for sudo.');
  // The line picks a Node outside the home folders; a root step that still finds itself under one stops here — the service would depend on a folder
  // that is someone's to change and to close, and root would run a program from it.
  const nodeHome = findHomeContaining(deps.nodePath);
  if (nodeHome !== null) return fail(`This step runs under the Node.js at ${deps.nodePath}, which lives in a home folder (${nodeHome}): root runs nothing from a home, and the service must not depend on one. Install Node.js system-wide (macOS: brew install node) and paste the admin line again.`);
  const account = await deps.resolveAccount(accountName);
  if (account === null) return fail(`There is no account named «${accountName}», or its home folder cannot be read from the directory service.`);
  if (account.uid === rootUid) return fail('The service must run as a standard account, not as root.');
  // And a Node the account can change is no Node for root to run: the account runs the agents' code. `remoteRun/pickNode.sh` asks the same before it picks.
  const changeable = await findPathAccountCanWrite(deps.nodePath, account, deps);
  if (changeable !== null) return fail(`This step runs under the Node.js at ${deps.nodePath}, which the account ${account.name} can change (it can write ${changeable}): root runs nothing the account can change. Install Node.js system-wide (macOS: brew install node) and paste the admin line again.`);
  return account;
}

/** @description The first of `programPath` and the folders above it (up to, not including, `/`) that `account` can write — judged AS the account, `sudo -u <account> -H test -w` — or `null`. */
async function findPathAccountCanWrite(programPath: string, account: TargetAccount, deps: AdminServiceDeps): Promise<string | null> {
  for (let location = programPath; location !== '' && location !== path.parse(location).root; location = path.dirname(location)) {
    const probe = await deps.runner('sudo', [...asAccountArgs(account), 'test', '-w', location], { timeoutMs: commandTimeoutMs });
    if (probe.ok) return location;
  }
  return null;
}

function checkIsTargetAccount(resolved: TargetAccount | ServiceResult): resolved is TargetAccount {
  return 'uid' in resolved;
}

/**
 * @description Pair the account from the root-owned copy of the package: its pairing program run AS the account (`sudo -u <account> -H node
 * <this copy>/runnerCli.js pair …`) with no terminal, its output relayed as it arrives. The program is the copy's, never the account's own;
 * `--service-follows` tells it the service is installed next, so it prints no «keep it running» help.
 */
export async function pairAccountFromPackage(accountName: string, request: PairRequest, deps: AdminServiceDeps): Promise<ServiceResult> {
  const account = await resolveServedAccount(accountName, deps);
  if (!checkIsTargetAccount(account)) return account;
  const pairArgs = ['pair', '--bootstrap', request.bootstrapDir, '--archive', request.archivePath, '--package-id', request.packageId, serviceFollowsFlag, request.code];
  const paired = await deps.runner('sudo', [...asAccountArgs(account), deps.nodePath, deps.runnerCliPath, ...pairArgs], { timeoutMs: pairAsAccountTimeoutMs, onOutput: (text, stream) => { deps.write(stream, text); } });
  if (paired.ok) return { ok: true, lines: [] };
  // Its own words were relayed above.
  return fail(paired.isTimedOut ? `The pairing of ${account.name} did not finish within ${pairAsAccountTimeoutMs / 60_000} minutes.` : `The pairing of ${account.name} failed (${paired.exitCode === null ? 'it did not run to its end' : `exit ${paired.exitCode}`}); see above.`);
}

/**
 * @description The lines that warn the admin when `accountName` — the account that runs the agents' code — can read the home folders of other
 * users (macOS makes them `750`, group `staff`, and a standard account is in `staff`), naming them with the one-line fix; `[]` when it can read
 * none, or the account cannot be found. Judged AS the account (`sudo -u <account> test -r … -a -x …`, no terminal), never by root's own rights.
 */
export async function warnAboutReadableHomes(accountName: string, deps: AdminServiceDeps): Promise<string[]> {
  const account = await deps.resolveAccount(accountName);
  if (account === null) return [];
  const homes = await findReadableHomes(account.name, account.homeDir, {
    listFolders: deps.listFolders,
    checkCanRead: async (folder) => (await deps.runner('sudo', [...asAccountArgs(account), 'test', '-r', folder, '-a', '-x', folder], { timeoutMs: commandTimeoutMs })).ok,
  });
  return formatReadableHomesWarning(account.name, homes);
}

/** @description Install the always-on service of `accountName`, an account that is already paired. Needs root; touches nothing of the account's but through the account. */
export async function installServiceForAccount(accountName: string, deps: AdminServiceDeps): Promise<ServiceResult> {
  const account = await resolveServedAccount(accountName, deps);
  if (!checkIsTargetAccount(account)) return account;
  return deps.platform === 'darwin' ? installDaemons(account, deps) : installUserServiceFor(account, deps);
}
