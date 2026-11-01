import { createHash } from 'crypto';
import * as path from 'path';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description The text of the two services a runner needs, pure: the LINK (`charness-runner run` through the launcher) and PUEUED (the
 * queue — a service of its own, so a link restart or an update never touches a queued or running job). Names carry a short hash of the state
 * folder, so a second runner on one machine (a stand-in, another account) never clashes with this one.
 *
 *   Linux   two systemd USER units (no root); `KillMode=process` on the link: stopping it ends the launcher and nothing else, and the
 *           commands it started (a lease watcher among them) see the closed pipe and finish by themselves — they are not killed with it.
 *   macOS   two launchd jobs: LaunchAgents (run while the account is logged in, switched away included), or — with `--system` — LaunchDaemons
 *           with `UserName=<account>` (always, also logged out; they run as that account, with no extra rights). `AbandonProcessGroup`
 *           keeps launchd from killing what the link started when the link ends. Pueue runs at `nice`, never `taskpolicy -b` (on Apple
 *           Silicon that pins jobs to the efficiency cores).
 */

const hashLength = 8;
const restartSeconds = 5;
const throttleSeconds = 10;
const pueuedNiceness = 10;
const systemPathDirs: readonly string[] = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export interface ServiceNames {
  hash: string;
  systemdLink: string;
  systemdPueued: string;
  launchdLink: string;
  launchdPueued: string;
}

export function getServiceNames(stateRoot: string): ServiceNames {
  const hash = createHash('sha256').update(stateRoot).digest('hex').slice(0, hashLength);
  return {
    hash,
    systemdLink: `charness-runner-${hash}.service`,
    systemdPueued: `charness-runner-pueued-${hash}.service`,
    launchdLink: `com.charness.runner.${hash}`,
    launchdPueued: `com.charness.runner.pueued.${hash}`,
  };
}

/** A word of an `ExecStart=` line: double-quoted, with the characters systemd would read specially escaped. */
function quoteSystemdWord(word: string): string {
  return `"${word.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function renderSystemdLinkUnit(paths: RunnerHomePaths, names: ServiceNames): string {
  return [
    '[Unit]',
    `Description=charness runner link (${paths.root.replace(/%/g, '%%')})`,
    `Wants=network-online.target ${names.systemdPueued}`,
    `After=network-online.target ${names.systemdPueued}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoteSystemdWord(paths.launcher)} run`,
    'Restart=always',
    `RestartSec=${restartSeconds}`,
    'KillMode=process',
    'SyslogIdentifier=charness-runner',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function renderSystemdPueuedUnit(paths: RunnerHomePaths): string {
  return [
    '[Unit]',
    `Description=charness runner queue, Pueue (${paths.root.replace(/%/g, '%%')})`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoteSystemdWord(path.join(paths.binDir, 'pueued'))} --config ${quoteSystemdWord(paths.pueueConfig)}`,
    'Restart=always',
    `RestartSec=${restartSeconds}`,
    `Nice=${pueuedNiceness}`,
    'SyslogIdentifier=charness-runner-pueued',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export interface LaunchdJobSpec {
  label: string;
  programArguments: readonly string[];
  /** Set for a LaunchDaemon: the account the job runs as. */
  userName: string | null;
  homeDir: string;
  accountName: string;
  nodeDir: string;
  logPath: string;
  niceness: number | null;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** @description The property list of one launchd job. */
export function renderLaunchdPlist(spec: LaunchdJobSpec): string {
  const pathValue = [...new Set([path.join(spec.homeDir, '.charness-runner', 'bin'), spec.nodeDir, ...systemPathDirs])].join(':');
  const entry = (key: string, value: string): string => `    <key>${key}</key><string>${escapeXml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${escapeXml(spec.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...spec.programArguments.map((argument) => `    <string>${escapeXml(argument)}</string>`),
    '  </array>',
    ...(spec.userName === null ? [] : [`  <key>UserName</key><string>${escapeXml(spec.userName)}</string>`]),
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>ThrottleInterval</key><integer>${throttleSeconds}</integer>`,
    '  <key>AbandonProcessGroup</key><true/>',
    ...(spec.niceness === null ? [] : [`  <key>Nice</key><integer>${spec.niceness}</integer>`]),
    `  <key>WorkingDirectory</key><string>${escapeXml(spec.homeDir)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    entry('HOME', spec.homeDir),
    entry('USER', spec.accountName),
    entry('LOGNAME', spec.accountName),
    entry('PATH', pathValue),
    '  </dict>',
    `  <key>StandardOutPath</key><string>${escapeXml(spec.logPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${escapeXml(spec.logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface LaunchdJobs {
  link: LaunchdJobSpec;
  pueued: LaunchdJobSpec;
}

/** @description The two jobs of a runner; `userName` is set for LaunchDaemons. */
export function planLaunchdJobs(paths: RunnerHomePaths, names: ServiceNames, accountName: string, nodeDir: string, userName: string | null): LaunchdJobs {
  const common = { userName, homeDir: paths.homeDir, accountName, nodeDir };
  return {
    link: { ...common, label: names.launchdLink, programArguments: [paths.launcher, 'run'], logPath: path.join(paths.logsDir, 'link.log'), niceness: null },
    pueued: { ...common, label: names.launchdPueued, programArguments: [path.join(paths.binDir, 'pueued'), '--config', paths.pueueConfig], logPath: path.join(paths.logsDir, 'pueued.log'), niceness: pueuedNiceness },
  };
}

export type LingerState = 'yes' | 'no' | 'unknown';

/** @description `Linger=yes|no` out of `loginctl show-user <user> -p Linger`. */
export function parseLingerState(output: string): LingerState {
  const match = /Linger=(yes|no)/.exec(output);
  return match === null ? 'unknown' : match[1] === 'yes' ? 'yes' : 'no';
}

/** @description What to tell the operator when lingering could not be switched on by the account itself (polkit wants an admin there). */
export function describeLingerRemedy(accountName: string): string {
  return `Lingering is off, so the runner stops when ${accountName} logs out. Turn it on once, as an admin: sudo loginctl enable-linger ${accountName}`;
}
