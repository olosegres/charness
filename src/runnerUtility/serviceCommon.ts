import * as fs from 'fs';
import * as path from 'path';
import { getOutputTail, type CommandRunner } from '../selfUpdate/commandRunner';
import type { LaunchdJobSpec, ServiceNames } from './serviceUnits';

/**
 * @description What the account's own service install (`serviceManager.ts`, needs the installed package and so its dependencies) and the
 * admin's root step (`adminService.ts`, runs from a root-owned copy of the package that has NO dependencies) share: the result shape, the
 * account lookups, the launchd job loader with its rollback, and the definition files. Node built-ins only, because the root step may
 * import nothing else.
 */

export const commandTimeoutMs = 60 * 1000;
/** Where the admin line puts the always-on service's LaunchDaemon definitions (a folder only root can write). */
export const systemLaunchDaemonsDir = '/Library/LaunchDaemons';
/** Where the admin line installs the runner's Node.js, owned by root: root runs that Node, so the account must not be able to change it (`remoteRun/ensureNode.sh`, `managedNode.ts`). */
export const sharedNodeBase = '/usr/local/lib/charness-runner/node';
export const rootUid = 0;
const wheelGid = 0;
const unitFileMode = 0o644;
const logsDirMode = 0o700;
const unloadPollMs = 300;
const unloadPollAttempts = 10;

export interface TargetAccount {
  name: string;
  uid: number;
  gid: number;
  homeDir: string;
}

export interface ServiceResult {
  ok: boolean;
  lines: string[];
}

export function fail(...lines: string[]): ServiceResult {
  return { ok: false, lines };
}

/**
 * @description What the account's `service system-step prepare` tells the admin step (one JSON line on stdout). The admin step never
 * touches the account's tree itself: everything of the account's — Pueue, its configuration, the service record — is done by the account's
 * own program, run AS the account, and root reads only this answer. The answer is not trusted for anything but what to say and whether
 * the account's service was there before: what root writes is rendered from the account's name and home alone.
 */
export type SystemStepAnswer = { ok: true; hadService: boolean } | { ok: false; lines: string[] };

export function formatSystemStepAnswer(answer: SystemStepAnswer): string {
  return `${JSON.stringify(answer)}\n`;
}

/** @description The answer in the LAST non-empty line of `output`, or `null` when there is none that reads as one. */
export function parseSystemStepAnswer(output: string): SystemStepAnswer | null {
  const lastLine = output.split('\n').map((line) => line.trim()).filter((line) => line !== '').at(-1);
  if (lastLine === undefined) return null;
  try {
    const parsed: { ok?: boolean; hadService?: boolean; lines?: string[] } = JSON.parse(lastLine);
    if (parsed.ok === true && typeof parsed.hadService === 'boolean') return { ok: true, hadService: parsed.hadService };
    if (parsed.ok === false && Array.isArray(parsed.lines) && parsed.lines.every((line) => typeof line === 'string')) return { ok: false, lines: parsed.lines };
  } catch {
    return null;
  }
  return null;
}

export interface ServiceFiles {
  /** Where the link and pueued definitions are written. */
  link: string;
  pueued: string;
  directory: string;
}

export function getLaunchdFiles(isSystem: boolean, homeDir: string, names: ServiceNames, daemonsDir: string): ServiceFiles {
  const directory = isSystem ? daemonsDir : path.join(homeDir, 'Library', 'LaunchAgents');
  return { directory, link: path.join(directory, `${names.launchdLink}.plist`), pueued: path.join(directory, `${names.launchdPueued}.plist`) };
}

/** @description Where the login session's agent's definition lives: in the ACCOUNT's own `~/Library/LaunchAgents` — the account writes it, root only loads it. */
export function getGuiAgentFile(homeDir: string, names: ServiceNames): string {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${names.launchdGui}.plist`);
}

/**
 * The account from `id` and the directory service (`dscl`). A home folder that cannot be read from there is NOT guessed: root writes
 * definitions that name it, so no answer means no account.
 */
export async function resolveMacAccount(name: string, runner: CommandRunner): Promise<TargetAccount | null> {
  const uid = await runner('id', ['-u', name], { timeoutMs: commandTimeoutMs });
  const gid = await runner('id', ['-g', name], { timeoutMs: commandTimeoutMs });
  if (!uid.ok || !gid.ok) return null;
  const home = await runner('dscl', ['.', '-read', `/Users/${name}`, 'NFSHomeDirectory'], { timeoutMs: commandTimeoutMs });
  const homeDir = home.ok ? /NFSHomeDirectory:\s*(\S.*)$/m.exec(home.stdout)?.[1].trim() : undefined;
  if (homeDir === undefined || !path.isAbsolute(homeDir)) return null;
  return { name, uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()), homeDir };
}

/** `getent passwd <name>` → `name:x:uid:gid:gecos:home:shell`. */
export async function resolveLinuxAccount(name: string, runner: CommandRunner): Promise<TargetAccount | null> {
  const entry = await runner('getent', ['passwd', name], { timeoutMs: commandTimeoutMs });
  if (!entry.ok) return null;
  const [accountName, , uid, gid, , homeDir] = entry.stdout.trim().split(':');
  if (accountName !== name || homeDir === undefined || homeDir === '' || !/^\d+$/.test(uid) || !/^\d+$/.test(gid)) return null;
  return { name, uid: Number(uid), gid: Number(gid), homeDir };
}

export function writeDefinition(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, { mode: unitFileMode });
  fs.chmodSync(filePath, unitFileMode);
}

export interface PreviousDefinition {
  file: string;
  /** The text the file had before this install rewrote it; `null` = there was no such file. */
  content: string | null;
}

/** @description The files of a service that already exists, as they are now: a failed re-install puts them back instead of tearing the working service down. */
export function readPreviousDefinitions(files: readonly string[]): PreviousDefinition[] {
  return files.map((file) => ({ file, content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }));
}

/** @description Put `previous` back: a file that existed gets its text again, one this install made new (it had no earlier version) is removed. */
export function restorePreviousDefinitions(previous: readonly PreviousDefinition[]): void {
  for (const { file, content } of previous) {
    if (content === null) fs.rmSync(file, { force: true });
    else writeDefinition(file, content);
  }
}

/**
 * @description Boot a job out and wait (bounded: 3 s) until launchd no longer has it loaded; `false` when it still is. A `bootstrap` right
 * after a `bootout` often fails with error 5 while launchd is still tearing the old job down, and a check right after it can find the job
 * «still loaded»: `print` succeeds only for a job that is still loaded.
 */
export async function bootOutAndWaitUntilGone(label: string, domain: string, runner: CommandRunner): Promise<boolean> {
  await runner('launchctl', ['bootout', `${domain}/${label}`], { timeoutMs: commandTimeoutMs });
  for (let attempt = 0; attempt < unloadPollAttempts; attempt += 1) {
    const loaded = await runner('launchctl', ['print', `${domain}/${label}`], { timeoutMs: commandTimeoutMs });
    if (!loaded.ok) return true;
    await new Promise((resolve) => { setTimeout(resolve, unloadPollMs); });
  }
  return false;
}

export async function stopLaunchdJobs(labels: readonly string[], domain: string, runner: CommandRunner): Promise<string | null> {
  for (const label of labels) {
    if (!(await bootOutAndWaitUntilGone(label, domain, runner))) return `${label} is still loaded in ${domain}`;
  }
  return null;
}

/** What the launchd install needs to know about the kind of service it installs. */
export interface LaunchdInstallPlan {
  runner: CommandRunner;
  /** `system` for LaunchDaemons, `gui/<uid>` for LaunchAgents. */
  domain: string;
  files: ServiceFiles;
  names: Pick<ServiceNames, 'launchdLink' | 'launchdPueued'>;
  jobs: { link: LaunchdJobSpec; pueued: LaunchdJobSpec };
  /** A re-install: the service's definitions are put back when it fails, and its jobs are not torn down. */
  hadService: boolean;
  /** Make the folder a job's log goes to (a LaunchAgent's own); a daemon's is made by the account (the admin step never touches the account's tree). */
  isLogDirMade: boolean;
  /** Give a written definition to root:wheel (LaunchDaemons only; `lchown`, so a link is never followed). */
  giveToRoot?: (filePath: string, uid: number, gid: number) => void;
  /** A first install failed and everything it wrote is gone: forget the marker that said a service was coming. */
  forgetFirstInstall: () => Promise<void> | void;
  /** The text that says what to run to try again. */
  retryText: string;
  render: (job: LaunchdJobSpec) => string;
}

interface LaunchdEntry {
  job: LaunchdJobSpec;
  file: string;
}

/** @description Load the jobs in order; stops at the first that fails. `touchedFiles` are the definitions it had rewritten (and booted out the old job of) by then, the failing one included. */
async function loadLaunchdJobs(entries: readonly LaunchdEntry[], plan: LaunchdInstallPlan): Promise<ServiceResult & { touchedFiles: string[] }> {
  const touchedFiles: string[] = [];
  for (const { job, file } of entries) {
    if (plan.isLogDirMade) fs.mkdirSync(path.dirname(job.logPath), { recursive: true, mode: logsDirMode });
    touchedFiles.push(file);
    writeDefinition(file, plan.render(job));
    plan.giveToRoot?.(file, rootUid, wheelGid);
    await bootOutAndWaitUntilGone(job.label, plan.domain, plan.runner);
    const boot = await plan.runner('launchctl', ['bootstrap', plan.domain, file], { timeoutMs: commandTimeoutMs });
    if (!boot.ok) return { ...fail(`launchctl bootstrap ${plan.domain} failed for ${job.label}: ${getOutputTail(boot, 1)}`), touchedFiles };
  }
  return { ok: true, lines: [], touchedFiles };
}

/**
 * @description Write and load the queue's job, then the link's. A failure rolls back: a first install is stopped and its files removed; a
 * re-install gets its earlier definitions back and loaded again, as far as it was touched, and says honestly whether that worked.
 */
export async function installLaunchdJobs(plan: LaunchdInstallPlan): Promise<ServiceResult> {
  const { files, names, hadService, runner, domain } = plan;
  const previous = hadService ? readPreviousDefinitions([files.pueued, files.link]) : [];
  const loaded = await loadLaunchdJobs([{ job: plan.jobs.pueued, file: files.pueued }, { job: plan.jobs.link, file: files.link }], plan);
  if (loaded.ok) return { ok: true, lines: [] };
  if (hadService) {
    // A re-install that fails must not leave the working service unloaded: the definitions this pass rewrote come back, and launchd
    // loads those jobs again. A job the pass never reached keeps running untouched. Each load is checked and the answer is honest.
    const touched = previous.filter((entry) => loaded.touchedFiles.includes(entry.file));
    restorePreviousDefinitions(touched);
    const notLoaded: string[] = [];
    for (const { file, content } of touched) {
      const label = file === files.link ? names.launchdLink : names.launchdPueued;
      await bootOutAndWaitUntilGone(label, domain, runner);
      if (content === null) continue;
      plan.giveToRoot?.(file, rootUid, wheelGid);
      const reboot = await runner('launchctl', ['bootstrap', domain, file], { timeoutMs: commandTimeoutMs });
      if (!reboot.ok) notLoaded.push(label);
    }
    return fail(...loaded.lines, notLoaded.length === 0
      ? 'The service installed before was loaded again as it was.'
      : `The service installed before could NOT be loaded again (${notLoaded.join(', ')}): ${plan.retryText}`);
  }
  await stopLaunchdJobs([names.launchdLink, names.launchdPueued], domain, runner);
  for (const file of [files.link, files.pueued]) fs.rmSync(file, { force: true });
  await plan.forgetFirstInstall();
  return fail(...loaded.lines, 'Nothing was left installed.');
}
