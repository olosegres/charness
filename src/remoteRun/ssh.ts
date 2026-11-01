import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shellSingleQuote } from '../utils/tmuxExec';
import type { RunnerConfig } from './runnersConfig';

/**
 * @description Everything that touches ssh: the argument lists (pure, unit-tested), the quoting for the remote shell, and the process
 * helpers. Always non-interactive (`BatchMode`: a password or an unknown host key is an error, never a prompt), host keys checked as the
 * operator's ssh config says (never `StrictHostKeyChecking=no`), one master connection per runner shared by the several short calls of a
 * run (`ControlMaster`), and every spawned command with a deadline: a blocked connection must end in time, not hang the agent.
 */

const connectTimeoutSeconds = 15;
const serverAliveIntervalSeconds = 15;
const serverAliveCountMax = 3;
const controlPersistSeconds = 60;
/** The longest a unix socket path may be (sun_path, with a margin); ssh refuses a longer ControlPath. */
const unixSocketPathLimit = 100;
/** `%C` in a ControlPath expands to a 40-character hash. */
const controlPathHashLength = 40;
const cacheDirectoryMode = 0o700;

/** @description Where remote-run keeps its local cache (ssh control sockets, the last probe of each runner): `${XDG_CACHE_HOME:-~/.cache}/charness/remote-run`. */
export function getRemoteRunCacheDir(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const cacheHome = env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== '' ? env.XDG_CACHE_HOME : path.join(homeDir, '.cache');
  return path.join(cacheHome, 'charness', 'remote-run');
}

/** @description Create the cache dir (mode 0700) and its ssh folder. */
export function ensureRemoteRunCacheDir(cacheDir: string): void {
  fs.mkdirSync(path.join(cacheDir, 'ssh'), { recursive: true, mode: cacheDirectoryMode });
  fs.chmodSync(cacheDir, cacheDirectoryMode);
  fs.chmodSync(path.join(cacheDir, 'ssh'), cacheDirectoryMode);
}

/** A path that holds one of these cannot reach ssh's option parser AND rsync's `-e` parser as the same single word. */
const unquotablePathPattern = /["'\\$`\r\n]/;

/** @description Can `value` be put into an ssh option or a command line that ssh and rsync's `-e` both read back as one word? (Whitespace can; a quote, a backslash, a `$`, a backtick or a line break cannot.) */
export function checkIsSshPathQuotable(value: string): boolean {
  return !unquotablePathPattern.test(value);
}

/** @description ssh expands `%`-tokens in a ProxyCommand, an identity file, a known-hosts path and a ControlPath: a literal `%` is written `%%`. */
export function escapeSshTokens(value: string): string {
  return value.replace(/%/g, '%%');
}

/**
 * @description A path as the VALUE of an `-o` option. ssh reads `-o` like a line of its config file: `UserKnownHostsFile` there is a LIST of
 * files separated by whitespace and `ControlPath` takes one word followed by nothing, so `/home/my user/…` would be two words and ssh would
 * fail or look in the wrong place. Double quotes keep one path one word (ssh_config(5): «arguments may optionally be enclosed in double
 * quotes»); `-i` takes its path as a plain argument and needs none.
 */
export function quoteSshOptionPath(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * @description The ssh options of every call to `runner` (without the destination): the operator's own first — ssh keeps the first value of an
 * option — then ours. The shared connection is an optimisation: a cache path that is too long for a unix socket, or holds a character that
 * cannot be quoted, turns it off instead of failing the call.
 */
export function buildSshArgs(runner: Pick<RunnerConfig, 'sshOptions'>, cacheDir: string): string[] {
  const controlDirectory = path.join(cacheDir, 'ssh');
  const isControlPathUsable = controlDirectory.length + 1 + controlPathHashLength <= unixSocketPathLimit && checkIsSshPathQuotable(controlDirectory);
  return [
    ...(runner.sshOptions ?? []),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    '-o', `ServerAliveInterval=${serverAliveIntervalSeconds}`,
    '-o', `ServerAliveCountMax=${serverAliveCountMax}`,
    ...(isControlPathUsable
      ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${quoteSshOptionPath(path.join(escapeSshTokens(controlDirectory), '%C'))}`, '-o', `ControlPersist=${controlPersistSeconds}`]
      : ['-o', 'ControlMaster=no']),
  ];
}

const safeWordPattern = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** @description Is `word` one that needs no quoting for a POSIX shell (and for ssh's and rsync's own parsers)? */
export function checkIsPlainShellWord(word: string): boolean {
  return safeWordPattern.test(word);
}

/** @description One word quoted for a POSIX shell (`shellSingleQuote`; an already plain word stays as it is, so the commands read well in a log). */
export function quoteShellWord(word: string): string {
  return word !== '' && checkIsPlainShellWord(word) ? word : shellSingleQuote(word);
}

/** @description The words of an argument list as one string rsync's `-e` and a shell both read back as the same words. */
export function joinShellWords(words: readonly string[]): string {
  return words.map(quoteShellWord).join(' ');
}

/** @description The `-e` command of rsync: `ssh <options> <destination>` is rsync's to complete, so this is `ssh <options>`. */
export function buildRsyncSshCommand(runner: Pick<RunnerConfig, 'sshOptions'>, cacheDir: string): string {
  return joinShellWords(['ssh', ...buildSshArgs(runner, cacheDir)]);
}

/** @description A path for the REMOTE shell: a leading `~` stays unquoted so the runner's shell expands it. */
export function quoteRemotePath(remotePath: string): string {
  if (remotePath === '~') return '~';
  if (remotePath.startsWith('~/')) return `~/${quoteShellWord(remotePath.slice(2))}`;
  return quoteShellWord(remotePath);
}

export interface RunnerScriptCall {
  runner: Pick<RunnerConfig, 'workDir' | 'pueue'>;
  /** `runner-<sha8>.sh` */
  scriptName: string;
  subcommand: string;
  /** After the work dir the script always gets first. */
  args: readonly string[];
}

/** @description The command line that runs one subcommand of the uploaded script on the runner (Pueue's binary and config through the environment). */
export function buildRunnerScriptCommand(call: RunnerScriptCall): string {
  const environment = [
    ...(call.runner.pueue?.bin === undefined ? [] : [`PUEUE_BIN=${quoteRemotePath(call.runner.pueue.bin)}`]),
    ...(call.runner.pueue?.config === undefined ? [] : [`PUEUE_CONFIG=${quoteRemotePath(call.runner.pueue.config)}`]),
  ];
  const scriptPath = `${quoteRemotePath(call.runner.workDir)}/bin/${call.scriptName}`;
  return [...environment, 'bash', scriptPath, call.subcommand, quoteRemotePath(call.runner.workDir), ...call.args.map(quoteShellWord)].join(' ');
}

/** @description The command that writes the script from stdin into `<workDir>/bin/` unless it is already there (a temp file and a rename, so a half upload is never run). */
export function buildScriptUploadCommand(runner: Pick<RunnerConfig, 'workDir'>, scriptName: string): string {
  const binDirectory = `${quoteRemotePath(runner.workDir)}/bin`;
  const target = `${binDirectory}/${scriptName}`;
  const temporary = `${binDirectory}/.${scriptName}.$$`;
  return `mkdir -p ${binDirectory} && cat > ${temporary} && chmod 755 ${temporary} && mv -f ${temporary} ${target}`;
}

export function buildScriptExistsCommand(runner: Pick<RunnerConfig, 'workDir'>, scriptName: string): string {
  return `test -f ${quoteRemotePath(runner.workDir)}/bin/${scriptName}`;
}

/** The exit status ssh itself reports when it could not run the command. */
export const sshFailureExitCode = 255;

/**
 * @description Did the ssh call end because the CONNECTION failed (ssh's own status 255, or a process that was killed), rather than
 * because the command on the runner ended with a status of its own? The runner script's refusals exit 125 and a job's code is whatever its
 * command returned, so only this one is worth opening the connection again for.
 */
export function checkIsConnectionLost(exitCode: number | null): boolean {
  return exitCode === null || exitCode === sshFailureExitCode;
}

export interface SshRunResult {
  /** `null` when the process was killed (a timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  isTimedOut: boolean;
}

export interface SshRunParams {
  runner: Pick<RunnerConfig, 'ssh' | 'sshOptions'>;
  cacheDir: string;
  remoteCommand: string;
  /** Written to the command's stdin, then closed. */
  input?: string;
  /** The deadline; the ssh process is killed when it passes. */
  timeoutMs: number;
  /** Ends the call from outside (a caller's own, shared deadline): the ssh process is killed and the result says it was cut off. */
  signal?: AbortSignal;
}

/** @description Run one command on the runner and collect its output, with a deadline. */
export function runSshCommand(params: SshRunParams): Promise<SshRunResult> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...buildSshArgs(params.runner, params.cacheDir), params.runner.ssh, params.remoteCommand], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let isTimedOut = false;
    const cutOff = (): void => {
      isTimedOut = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(cutOff, params.timeoutMs);
    if (params.signal?.aborted === true) cutOff();
    else params.signal?.addEventListener('abort', cutOff, { once: true });
    const settle = (): void => {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', cutOff);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', () => { /* the command ended before it read its input */ });
    child.on('error', (error) => {
      settle();
      resolve({ exitCode: sshFailureExitCode, stdout, stderr: `${stderr}${error.message}\n`, isTimedOut });
    });
    child.on('close', (exitCode) => {
      settle();
      resolve({ exitCode, stdout, stderr, isTimedOut });
    });
    child.stdin.end(params.input ?? '');
  });
}

/** @description Start a long-lived ssh command whose streams the caller handles itself (the lease, `exec`, `wait`); the caller owns its deadline and its end. */
export function spawnSshStream(params: Omit<SshRunParams, 'input' | 'timeoutMs'>): ChildProcessWithoutNullStreams {
  return spawn('ssh', [...buildSshArgs(params.runner, params.cacheDir), params.runner.ssh, params.remoteCommand], { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** @description Close the master connection of a runner (`ssh -O exit`), best effort: a lingering master is harmless (ControlPersist ends it) but a test wants none left. */
export function closeSshMaster(runner: Pick<RunnerConfig, 'ssh' | 'sshOptions'>, cacheDir: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...buildSshArgs(runner, cacheDir), '-O', 'exit', runner.ssh], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), connectTimeoutSeconds * 1000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
