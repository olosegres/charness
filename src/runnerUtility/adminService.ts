import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getOutputTail, runCommand, type CommandRunner } from '../selfUpdate/commandRunner';
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
 */

/** The install run as the account starts two services and may wait for each. */
const installAsAccountTimeoutMs = 120 * 1000;
/** After `enable-linger` the user manager takes a moment to come up: it is asked once a second, for this many tries. */
const userManagerPollMs = 1000;
const userManagerPollAttempts = 20;
/** What `systemctl --user is-system-running` prints once the manager can take units (`degraded`: up, with some unit failed). */
const userManagerReadyStates: readonly string[] = ['running', 'degraded'];
const freshLineText = 'paste a fresh admin line from /runners (it finds the account paired and only installs the service)';

export interface AdminServiceDeps {
  runner: CommandRunner;
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
}

export function createAdminServiceDeps(): AdminServiceDeps {
  return {
    runner: runCommand,
    platform: process.platform,
    uid: os.userInfo().uid,
    nodeDir: path.dirname(process.execPath),
    launchDaemonsDir: '/Library/LaunchDaemons',
    giveToRoot: fs.lchownSync,
    resolveAccount: (name) => (process.platform === 'darwin' ? resolveMacAccount(name, runCommand) : resolveLinuxAccount(name, runCommand)),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
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

/** @description Install the always-on service of `accountName`, an account that is already paired. Needs root; touches nothing of the account's but through the account. */
export async function installServiceForAccount(accountName: string, deps: AdminServiceDeps): Promise<ServiceResult> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') return fail(`Services are supported on Linux (systemd) and macOS (launchd), not on ${deps.platform}.`);
  if (deps.uid !== rootUid) return fail('This step is root\'s: it is started by the admin pairing line from /runners, which asks for sudo.');
  const account = await deps.resolveAccount(accountName);
  if (account === null) return fail(`There is no account named «${accountName}», or its home folder cannot be read from the directory service.`);
  if (account.uid === rootUid) return fail('The service must run as a standard account, not as root.');
  return deps.platform === 'darwin' ? installDaemons(account, deps) : installUserServiceFor(account, deps);
}
