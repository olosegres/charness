import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RemoteRunError, RunnerUnreachableError } from './remoteRunError';
import type { RunnerConfig } from './runnersConfig';
import {
  buildRsyncSshCommand,
  buildRunnerScriptCommand,
  buildScriptExistsCommand,
  buildScriptUploadCommand,
  runSshCommand,
  checkIsConnectionLost,
  spawnSshStream,
  type SshRunResult,
} from './ssh';

/**
 * @description One runner as the rest of remote-run uses it: the uploaded script's subcommands as calls, Pueue through the same
 * script, and the pieces rsync needs. The script is `remoteRun/runner.sh` at the package root (shipped in `files`, like the STT
 * sidecar); it is uploaded to `<workDir>/bin/runner-<sha8>.sh` when that file is missing, so two versions of charness on one
 * runner never clash.
 */

const scriptHashLength = 8;
/** An ordinary call: a prepare may start the Pueue daemon, a result or a kill is quicker. */
export const shortCallTimeoutMs = 60 * 1000;
const scriptUploadTimeoutMs = 60 * 1000;

export interface RunnerScript {
  /** `runner-<sha8>.sh` */
  name: string;
  text: string;
}

/** @description `remoteRun/runner.sh` at the package root, resolved from both `src/remoteRun` (tsx) and `dist/remoteRun` (built): two levels up. */
export function getRunnerScriptPath(): string {
  return path.join(fs.realpathSync(__dirname), '..', '..', 'remoteRun', 'runner.sh');
}

export function readRunnerScript(scriptPath: string = getRunnerScriptPath()): RunnerScript {
  const text = fs.readFileSync(scriptPath, 'utf8');
  return { name: `runner-${createHash('sha256').update(text).digest('hex').slice(0, scriptHashLength)}.sh`, text };
}

export interface RunnerClient {
  readonly runner: RunnerConfig;
  readonly cacheDir: string;
  /** The `-e` command of rsync for this runner. */
  readonly rsyncSshCommand: string;
  /**
   * Upload the script when the runner does not have this version; throws a {@link RunnerUnreachableError} when the runner cannot be
   * reached. `signal` ends the ssh calls it makes from outside (a shared deadline).
   */
  ensureScript: (signal?: AbortSignal) => Promise<void>;
  /** The runner's work dir as an absolute path (a configured `~/…` is resolved on the runner once). */
  getAbsoluteWorkDir: () => Promise<string>;
  /** One subcommand of the script; never throws for a non-zero exit (the caller reads it). */
  call: (subcommand: string, args: readonly string[], options?: { input?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<SshRunResult>;
  /** The same, but a non-zero exit or a timeout is a {@link RemoteRunError} carrying the runner's own message. */
  callOrThrow: (subcommand: string, args: readonly string[], options?: { input?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<string>;
  /** The long-lived form: a spawned ssh whose streams the caller handles. */
  stream: (subcommand: string, args: readonly string[]) => ReturnType<typeof spawnSshStream>;
}

/** @description The first useful line of a failed ssh's stderr, for a message (never the whole text: it may quote the destination). */
export function describeSshFailure(result: SshRunResult): string {
  if (result.isTimedOut) return 'ssh: the command ran past its deadline';
  const lines = result.stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const text = lines.length === 0 ? `ssh exited with ${result.exitCode ?? 'a signal'}` : lines[lines.length - 1];
  if (/host key verification failed/i.test(result.stderr)) return `ssh: the host key is not trusted yet — connect once by hand (ssh to this runner) so it is known`;
  if (/permission denied/i.test(result.stderr)) return 'ssh: the key was rejected (permission denied)';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** @description The runner script's own refusal in a stderr text («remote-run-runner: no such job: x» → «no such job: x»): the last line, without the script's prefix. */
export function describeRunnerRefusal(stderr: string, fallback: string): string {
  const lastLine = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '').pop();
  return lastLine === undefined ? fallback : lastLine.replace(/^remote-run-runner: /, '');
}

/** @description Create the client of `runner`. `script` and the spawn functions are injectable for the tests. */
export function createRunnerClient(runner: RunnerConfig, cacheDir: string, script: RunnerScript = readRunnerScript()): RunnerClient {
  const call: RunnerClient['call'] = (subcommand, args, options = {}) =>
    runSshCommand({
      runner,
      cacheDir,
      remoteCommand: buildRunnerScriptCommand({ runner, scriptName: script.name, subcommand, args }),
      input: options.input,
      timeoutMs: options.timeoutMs ?? shortCallTimeoutMs,
      signal: options.signal,
    });

  let absoluteWorkDir: string | null = runner.workDir.startsWith('/') ? runner.workDir : null;

  return {
    runner,
    cacheDir,
    rsyncSshCommand: buildRsyncSshCommand(runner, cacheDir),
    async getAbsoluteWorkDir() {
      if (absoluteWorkDir === null) {
        const resolved = await call('workdir', []);
        const first = resolved.stdout.trim().split('\n')[0];
        if (resolved.exitCode !== 0 || !first.startsWith('/')) throw new RemoteRunError(`runner "${runner.name}": could not resolve its work dir ${runner.workDir} — ${describeSshFailure(resolved)}`);
        absoluteWorkDir = first;
      }
      return absoluteWorkDir;
    },
    async ensureScript(signal) {
      const exists = await runSshCommand({ runner, cacheDir, remoteCommand: buildScriptExistsCommand(runner, script.name), timeoutMs: scriptUploadTimeoutMs, signal });
      if (exists.exitCode === 0) return;
      if (checkIsConnectionLost(exists.exitCode)) throw new RunnerUnreachableError(runner.name, describeSshFailure(exists));
      const upload = await runSshCommand({ runner, cacheDir, remoteCommand: buildScriptUploadCommand(runner, script.name), input: script.text, timeoutMs: scriptUploadTimeoutMs, signal });
      if (upload.exitCode !== 0) throw new RemoteRunError(`could not put the runner script on "${runner.name}" (${runner.workDir}/bin) — ${describeSshFailure(upload)}`);
    },
    call,
    async callOrThrow(subcommand, args, options) {
      const result = await call(subcommand, args, options);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() === '' ? describeSshFailure(result) : result.stderr.trim().split('\n').slice(-3).join(' / ');
        throw new RemoteRunError(`runner "${runner.name}": ${subcommand} failed — ${detail}`);
      }
      return result.stdout;
    },
    stream(subcommand, args) {
      return spawnSshStream({ runner, cacheDir, remoteCommand: buildRunnerScriptCommand({ runner, scriptName: script.name, subcommand, args }) });
    },
  };
}
