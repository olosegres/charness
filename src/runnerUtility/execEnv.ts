import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description The environment of a command that runs over the link — CLEAN, like a login by a service: the runner's own environment
 * (a launchd job's, a terminal's) never leaks into the agents' jobs. HOME, USER, LOGNAME, LANG, TMPDIR; a PATH of `~/.charness-runner/bin`
 * (pueue, rsync), the folder of the `node` that runs the utility, the Homebrew and system folders; the Android SDK when it is where
 * the usual installers put it; then the operator's own `KEY=VALUE` lines from `~/.charness-runner/env`.
 */

const systemPathDirs: readonly string[] = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const defaultLang = 'en_US.UTF-8';
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @description `KEY=VALUE` lines; blank lines and `#` comments are skipped, `export ` is allowed, one pair of quotes around a value is removed. A line that is not a pair is returned in `rejected` (its number, never its text — a value may be a secret). */
export function parseEnvFile(text: string): { values: Record<string, string>; rejected: number[] } {
  const values: Record<string, string> = {};
  const rejected: number[] = [];
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) return;
    const separator = line.indexOf('=');
    const name = separator === -1 ? '' : line.slice(0, separator).trim();
    if (!envNamePattern.test(name)) {
      rejected.push(index + 1);
      return;
    }
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) value = value.slice(1, -1);
    values[name] = value;
  });
  return { values, rejected };
}

/** @description The Android SDK folder if one is where the installers put it (or the environment says), else `null`. */
export function findAndroidSdk(homeDir: string, environment: NodeJS.ProcessEnv, checkExists: (candidate: string) => boolean = fs.existsSync): string | null {
  const candidates = [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT, path.join(homeDir, 'Library', 'Android', 'sdk'), path.join(homeDir, 'Android', 'Sdk'), '/opt/android-sdk'];
  return candidates.find((candidate): candidate is string => candidate !== undefined && candidate !== '' && checkExists(candidate)) ?? null;
}

export interface ExecEnvInputs {
  paths: RunnerHomePaths;
  accountName: string;
  /** The utility's own environment: only LANG and TMPDIR are taken from it. */
  environment: NodeJS.ProcessEnv;
  nodeDir: string;
  operatorEnv: Readonly<Record<string, string>>;
  androidSdk: string | null;
}

export function buildExecEnv(inputs: ExecEnvInputs): NodeJS.ProcessEnv {
  const pathDirs = [inputs.paths.binDir, inputs.nodeDir, ...systemPathDirs];
  return {
    HOME: inputs.paths.homeDir,
    USER: inputs.accountName,
    LOGNAME: inputs.accountName,
    LANG: inputs.environment.LANG ?? defaultLang,
    TMPDIR: inputs.environment.TMPDIR ?? os.tmpdir(),
    PATH: [...new Set(pathDirs)].join(path.delimiter),
    ...(inputs.androidSdk === null ? {} : { ANDROID_HOME: inputs.androidSdk, ANDROID_SDK_ROOT: inputs.androidSdk }),
    ...inputs.operatorEnv,
  };
}

/** @description The environment for the next command: the `env` file is read fresh each time, so an edit applies to the next job without a restart. */
export function readExecEnv(paths: RunnerHomePaths, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  let operatorEnv: Record<string, string> = {};
  try {
    operatorEnv = parseEnvFile(fs.readFileSync(paths.envFile, 'utf8')).values;
  } catch {
    operatorEnv = {};
  }
  return buildExecEnv({
    paths,
    accountName: os.userInfo().username,
    environment,
    nodeDir: path.dirname(process.execPath),
    operatorEnv,
    androidSdk: findAndroidSdk(paths.homeDir, environment),
  });
}
