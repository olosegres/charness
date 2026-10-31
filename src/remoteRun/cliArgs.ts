import { parseJobId } from './jobId';
import { runnerCapabilities, type RunnerCapability } from './probe';

/**
 * @description The command line of `charness remote-run`, parsed. Options come only BEFORE the command and parsing stops at the first
 * non-option word (like `env` and `ssh`); a command whose first word is a subcommand name goes after `--`. A subcommand is recognised
 * only as the very first word, so `remote-run --bg ls build` runs `ls build` and `remote-run ls` lists jobs.
 */

export interface RemoteRunOptions {
  /** `--runner`: use this one. */
  runner: string | null;
  /** `--needs`: the first runner that has this capability. */
  needs: RunnerCapability | null;
  /** `--group`: the Pueue group the job joins. */
  group: string | null;
  /** `--timeout` in seconds; `null` = the default. */
  timeoutSeconds: number | null;
  /** `--with-git`: send `.git` too. */
  isWithGit: boolean;
  /** `-e NAME=VALUE`, in order. */
  env: Array<{ name: string; value: string }>;
  /** `--bg`: print the job id and return. */
  isBackground: boolean;
}

export type RemoteRunCommand =
  | { kind: 'help' }
  | { kind: 'run'; options: RemoteRunOptions; command: string }
  | { kind: 'ls'; isAll: boolean }
  | { kind: 'status'; jobId: string }
  | { kind: 'logs'; jobId: string; isFollow: boolean; tail: number | null }
  | { kind: 'wait'; jobId: string }
  | { kind: 'kill'; jobId: string }
  | { kind: 'fetch'; jobId: string }
  | { kind: 'exec'; runner: string | null; command: string }
  | { kind: 'runners' };

export type RemoteRunArgsParse = { ok: true; command: RemoteRunCommand } | { ok: false; error: string };

export const defaultTimeoutSeconds = 3 * 60 * 60;
/** The longest `--timeout`: Node's timers keep delays only up to 2^31 ms (~24.8 days), a longer one fires at once and would kill the job. */
export const maxTimeoutSeconds = 7 * 24 * 60 * 60;

const groupNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const durationPartPattern = /(\d+)([hms]?)/g;
const secondsPerUnit: Record<string, number> = { h: 3600, m: 60, s: 1, '': 1 };

/** @description `90m`, `3h`, `1h30m`, `45s`, `600` (seconds) as seconds; `null` when it is none of those or zero. */
export function parseDuration(text: string): number | null {
  if (!/^(\d+[hms]?)+$/.test(text)) return null;
  let totalSeconds = 0;
  for (const part of text.matchAll(durationPartPattern)) totalSeconds += Number(part[1]) * secondsPerUnit[part[2]];
  return totalSeconds > 0 ? totalSeconds : null;
}

function createDefaultOptions(): RemoteRunOptions {
  return { runner: null, needs: null, group: null, timeoutSeconds: null, isWithGit: false, env: [], isBackground: false };
}

/** The value of `--name value` / `--name=value` at `index`, and how many words it took; `null` when this word is not that option. */
function readOptionValue(words: readonly string[], index: number, name: string): { value: string | undefined; consumed: number } | null {
  const word = words[index];
  if (word === name) {
    const value = words[index + 1];
    return value === undefined ? { value: undefined, consumed: 1 } : { value, consumed: 2 };
  }
  return word.startsWith(`${name}=`) ? { value: word.slice(name.length + 1), consumed: 1 } : null;
}

function parseJobIdArgument(words: readonly string[], commandName: string): { ok: true; jobId: string } | { ok: false; error: string } {
  const [jobId, ...extra] = words;
  if (jobId === undefined) return { ok: false, error: `${commandName} needs a job id` };
  if (parseJobId(jobId) === null) return { ok: false, error: `"${jobId}" is not a job id (they look like box1-abc234)` };
  if (extra.length > 0) return { ok: false, error: `${commandName} takes one job id, got extra: ${extra.join(' ')}` };
  return { ok: true, jobId };
}

function parseLogsArguments(words: readonly string[]): RemoteRunArgsParse {
  let isFollow = false;
  let tail: number | null = null;
  const positional: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const tailOption = readOptionValue(words, index, '--tail');
    if (word === '-f' || word === '--follow') isFollow = true;
    else if (tailOption !== null) {
      const lineCount = Number(tailOption.value);
      if (tailOption.value === undefined || !Number.isInteger(lineCount) || lineCount < 1) return { ok: false, error: '--tail needs a whole number of lines, 1 or more' };
      tail = lineCount;
      index += tailOption.consumed - 1;
    } else if (word.startsWith('-')) return { ok: false, error: `unknown option for logs: ${word}` };
    else positional.push(word);
  }
  const jobId = parseJobIdArgument(positional, 'logs');
  return jobId.ok ? { ok: true, command: { kind: 'logs', jobId: jobId.jobId, isFollow, tail } } : jobId;
}

function parseExecArguments(words: readonly string[]): RemoteRunArgsParse {
  let runner: string | null = null;
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index];
    if (word === '--') {
      index += 1;
      break;
    }
    const runnerOption = readOptionValue(words, index, '--runner');
    if (runnerOption !== null) {
      if (runnerOption.value === undefined || runnerOption.value === '') return { ok: false, error: '--runner needs a runner name' };
      runner = runnerOption.value;
      index += runnerOption.consumed - 1;
    } else if (word.startsWith('-')) return { ok: false, error: `unknown option for exec: ${word}` };
    else break;
  }
  const commandWords = words.slice(index);
  if (commandWords.length === 0) return { ok: false, error: 'exec needs a command' };
  return { ok: true, command: { kind: 'exec', runner, command: commandWords.join(' ') } };
}

/** The value-taking options of a run, each as the code that stores the value. */
function applyRunOption(options: RemoteRunOptions, name: string, value: string): string | null {
  if (name === '--runner') {
    if (value === '' || value.startsWith('-')) return '--runner needs a runner name';
    options.runner = value;
  } else if (name === '--needs') {
    const capability = runnerCapabilities.find((candidate) => candidate === value);
    if (capability === undefined) return `--needs must be one of: ${runnerCapabilities.join(', ')}`;
    options.needs = capability;
  } else if (name === '--group') {
    if (!groupNamePattern.test(value)) return '--group needs a Pueue group name (letters, digits, - and _)';
    options.group = value;
  } else if (name === '--timeout') {
    const seconds = parseDuration(value);
    if (seconds === null) return '--timeout needs a duration such as 90m, 3h, 1h30m or 600 (seconds)';
    if (seconds > maxTimeoutSeconds) return '--timeout is at most 7 days';
    options.timeoutSeconds = seconds;
  } else {
    const separator = value.indexOf('=');
    const envName = separator > 0 ? value.slice(0, separator) : '';
    const envValue = separator > 0 ? value.slice(separator + 1) : '';
    if (!envNamePattern.test(envName)) return '-e needs NAME=VALUE (NAME: letters, digits, _)';
    if (/[\n\0]/.test(envValue)) return `-e ${envName}: the value must not hold a newline`;
    options.env.push({ name: envName, value: envValue });
  }
  return null;
}

const runValueOptions: readonly string[] = ['--runner', '--needs', '--group', '--timeout'];

function parseRunArguments(words: readonly string[]): RemoteRunArgsParse {
  const options = createDefaultOptions();
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index];
    if (word === '--') {
      index += 1;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    if (word === '--bg') {
      options.isBackground = true;
      continue;
    }
    if (word === '--with-git') {
      options.isWithGit = true;
      continue;
    }
    const optionName = word === '-e' ? '-e' : runValueOptions.find((name) => word === name || word.startsWith(`${name}=`));
    if (optionName === undefined) return { ok: false, error: `unknown option: ${word} (options go before the command; a command that starts with "-" goes after --)` };
    const reading = readOptionValue(words, index, optionName);
    if (reading === null || reading.value === undefined) return { ok: false, error: `${optionName} needs a value` };
    const problem = applyRunOption(options, optionName, reading.value);
    if (problem !== null) return { ok: false, error: problem };
    index += reading.consumed - 1;
  }
  const commandWords = words.slice(index);
  if (commandWords.length === 0) return { ok: false, error: 'no command given' };
  return { ok: true, command: { kind: 'run', options, command: commandWords.join(' ') } };
}

/** @description Parse the words after `charness remote-run`. */
export function parseRemoteRunArgs(words: readonly string[]): RemoteRunArgsParse {
  const [first, ...rest] = words;
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') return { ok: true, command: { kind: 'help' } };
  switch (first) {
    case 'ls': {
      const unknown = rest.find((word) => word !== '--all');
      return unknown === undefined ? { ok: true, command: { kind: 'ls', isAll: rest.length > 0 } } : { ok: false, error: `unknown argument for ls: ${unknown}` };
    }
    case 'runners':
      return rest.length === 0 ? { ok: true, command: { kind: 'runners' } } : { ok: false, error: 'runners takes no arguments' };
    case 'logs':
      return parseLogsArguments(rest);
    case 'exec':
      return parseExecArguments(rest);
    case 'status':
    case 'wait':
    case 'kill':
    case 'fetch': {
      const jobId = parseJobIdArgument(rest, first);
      return jobId.ok ? { ok: true, command: { kind: first, jobId: jobId.jobId } } : jobId;
    }
    default:
      return parseRunArguments(words);
  }
}
