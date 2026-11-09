import * as path from 'path';
import { parseJobId } from './jobId';
import { getPathPatternProblem } from './pathPatterns';
import { runnerCapabilities, type RunnerCapability } from './probe';
import { quoteShellWord } from './ssh';

/**
 * @description The command line of `charness remote-run`, parsed. Options come only BEFORE the command and parsing stops at the first
 * non-option word (like `env` and `ssh`); a command whose first word is a subcommand name goes after `--`. A subcommand is recognised
 * as the very first word (`remote-run ls` lists jobs); a subcommand name that follows options is never run as a job of that name — it
 * is read as the subcommand when the options fit it (`--runner box1 exec ls`), and refused with the way out when they do not
 * (`--bg ls build` → «put -- before a command called ls»): `exec` is a shell builtin that replaces the job's shell, and `ls` run
 * where `ls` the subcommand was meant answers a different question without a word.
 */

export interface RemoteRunOptions {
  /** `--runner`: use this one. */
  runner: string | null;
  /** `--needs`: the first runner that has this capability. */
  needs: RunnerCapability | null;
  /** `--runner-wait` in seconds: how long to wait for an offline paired runner that has `--needs`; `0` = fail at once; `null` = the default. */
  runnerWaitSeconds: number | null;
  /** `--group`: the Pueue group the job joins. */
  group: string | null;
  /** `--timeout` in seconds; `null` = the default. */
  timeoutSeconds: number | null;
  /** `--with-git`: send `.git` too. */
  isWithGit: boolean;
  /** `--send <path>`, in order: files (patterns, as `send:` of `.remote-run`) sent for this call although they look like secrets or git ignores them. */
  send: string[];
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
  | { kind: 'clean'; slug: string | null }
  | { kind: 'runners' };

/** `note` is a line for stderr before the command goes out (a word that the runner will read again, see `joinCommandWords`). */
export type RemoteRunArgsParse = { ok: true; command: RemoteRunCommand; note?: string } | { ok: false; error: string };

export const defaultTimeoutSeconds = 3 * 60 * 60;
/** The longest `--timeout`: Node's timers keep delays only up to 2^31 ms (~24.8 days), a longer one fires at once and would kill the job. */
export const maxTimeoutSeconds = 7 * 24 * 60 * 60;

const groupNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** A project copy\'s name on a runner (`<basename>-<10 hex>`, see `getProjectSlug`): one safe path component, as `runner.sh` checks it too. */
const slugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const slugMaxLength = 80;
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
  return { runner: null, needs: null, runnerWaitSeconds: null, group: null, timeoutSeconds: null, isWithGit: false, send: [], env: [], isBackground: false };
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

/** `clean [<slug>]`: no word = the copy of the project the command is run in. */
function parseCleanArguments(words: readonly string[]): RemoteRunArgsParse {
  const [slug, ...extra] = words;
  if (slug === undefined) return { ok: true, command: { kind: 'clean', slug: null } };
  if (slug.startsWith('-')) return { ok: false, error: `unknown option for clean: ${slug} (clean takes a project copy\'s name, or nothing for the copy of this project)` };
  if (!slugPattern.test(slug) || slug.length > slugMaxLength) return { ok: false, error: `"${slug}" is not the name of a project copy (they look like myapp-0a1b2c3d4e)` };
  if (extra.length > 0) return { ok: false, error: `clean takes one project copy name, got extra: ${extra.join(' ')}` };
  return { ok: true, command: { kind: 'clean', slug } };
}

/** The shells whose `-c` takes a script: a word after it is part of that script's own command line, not a word of ours. */
const scriptShellNames: readonly string[] = ['sh', 'bash', 'zsh', 'dash', 'ksh'];

/** `-c`, or a bundle of single-letter flags that holds a `c` (`-lc`, `-ec`, `-xc`). */
const scriptFlagPattern = /^-[A-Za-z]*c[A-Za-z]*$/;

/** The options of a shell that take a value word of their own (`-o pipefail`, `-O extglob`, `+o`, `+O`): the value is no flag, whatever it looks like. */
const shellValueOptions: readonly string[] = ['-o', '-O', '+o', '+O'];

/** What the shell on the runner reads again when the words are joined: whitespace, a quote, an operator, an expansion or an escape. */
const shellSyntaxPattern = /[\s&|;<>()$`'"\\]/;

/** The line for stderr when words after the first would be read again on the runner. */
const rereadCommandNote = 'the words are joined with spaces and read again on the runner — pass the whole command as one quoted word';

/** The index of the `-c` word of `<shell> [options] -c <script> …` (the options are `-e`, `--login`, `-o pipefail`, …), or -1 when the words are no such invocation. */
function findScriptFlagIndex(words: readonly string[]): number {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (scriptFlagPattern.test(word)) return index;
    if (shellValueOptions.includes(word)) index += 1;
    else if (word === '--' || !(word.startsWith('-') || word.startsWith('+'))) return -1;
  }
  return -1;
}

/**
 * @description The words of a command as the ONE string the runner reads with its own `bash -c`. They are joined with spaces, so a word
 * that holds a space or an operator is read again by that shell (`charness remote-run 'yarn build && yarn test'` is one word that way, on
 * purpose). The one place where the words themselves say that a word is a single one is a shell given a script: `<shell> [options] -c <script>
 * [$0 $1 …]`. Joined plainly, `bash -c 'cd app && yarn e2e'` reached the runner as `bash -c cd app && yarn e2e` — a `bash -c cd` that does
 * nothing, and `yarn e2e` run in the project root (measured 2026-11-09: «Couldn't find a script named e2e:dev:ios:job», in a project
 * whose subfolder has it). So the script and the words after it are quoted, as the shell that typed them had them. Wrappers (`nice`, `env`, `timeout`, `sudo`)
 * and other interpreters (`python3 -c`) are not guessed at: when a word after the first would be read again, `note` says so (one line for stderr).
 */
export function joinCommandWords(words: readonly string[]): { command: string; note: string | null } {
  const [program] = words;
  const flagIndex = program !== undefined && scriptShellNames.includes(path.posix.basename(program)) ? findScriptFlagIndex(words) : -1;
  if (flagIndex !== -1 && flagIndex < words.length - 1) {
    return { command: [...words.slice(0, flagIndex + 1), ...words.slice(flagIndex + 1).map(quoteShellWord)].join(' '), note: null };
  }
  return { command: words.join(' '), note: words.slice(1).some((word) => shellSyntaxPattern.test(word)) ? rereadCommandNote : null };
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
  const joined = joinCommandWords(commandWords);
  return { ok: true, command: { kind: 'exec', runner, command: joined.command }, ...(joined.note === null ? {} : { note: joined.note }) };
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
  } else if (name === '--runner-wait') {
    // `0` is meaningful here («never wait»), unlike a timeout, so it is read before `parseDuration` (which refuses zero).
    const seconds = /^0+[hms]?$/.test(value) ? 0 : parseDuration(value);
    if (seconds === null) return '--runner-wait needs a duration such as 15m, 90s or 1h (seconds if no unit), or 0 to fail at once';
    if (seconds > maxTimeoutSeconds) return '--runner-wait is at most 7 days';
    options.runnerWaitSeconds = seconds;
  } else if (name === '--group') {
    if (!groupNamePattern.test(value)) return '--group needs a Pueue group name (letters, digits, - and _)';
    options.group = value;
  } else if (name === '--send') {
    const problem = getPathPatternProblem(value);
    if (problem !== null) return `--send pattern ${problem}`;
    options.send.push(value);
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

const runValueOptions: readonly string[] = ['--runner', '--needs', '--runner-wait', '--group', '--timeout', '--send'];

/** The words that name a subcommand when they come first; after options they are read as the subcommand or refused (`parseOptionsBeforeSubcommand`). */
const subcommandNames: readonly string[] = ['help', 'ls', 'runners', 'logs', 'exec', 'status', 'wait', 'kill', 'fetch', 'clean'];

/**
 * @description A subcommand name that follows options. `exec` takes `--runner`, so `--runner box1 exec ls` is the exec of `ls` on box1 (a
 * `--runner` after `exec` too must name the same runner); any other option does not apply to exec, and the other subcommands take none
 * of the run options — those are refused with the way to run a command that is simply called so.
 */
function parseOptionsBeforeSubcommand(name: string, rest: readonly string[], runner: string | null, usedOptions: readonly string[]): RemoteRunArgsParse {
  const wayOut = `a command that is called "${name}" goes after -- (charness remote-run [options] -- ${name} …)`;
  if (name !== 'exec') return { ok: false, error: `"${name}" is a remote-run subcommand and subcommands come first (charness remote-run ${name} …), so the options before it have no effect; ${wayOut}` };
  const notForExec = usedOptions.find((option) => option !== '--runner');
  if (notForExec !== undefined) return { ok: false, error: `${notForExec} does not apply to exec — before exec only --runner is understood (charness remote-run exec [--runner <name>] <command…>); ${wayOut}` };
  const parsed = parseExecArguments(rest);
  if (!parsed.ok || parsed.command.kind !== 'exec') return parsed;
  const { runner: runnerAfter, command } = parsed.command;
  if (runner !== null && runnerAfter !== null && runner !== runnerAfter) return { ok: false, error: `--runner names two runners for exec: ${runner} before it, ${runnerAfter} after it` };
  return { ok: true, command: { kind: 'exec', runner: runnerAfter ?? runner, command }, ...(parsed.note === undefined ? {} : { note: parsed.note }) };
}

function parseRunArguments(words: readonly string[]): RemoteRunArgsParse {
  const options = createDefaultOptions();
  const usedOptions: string[] = [];
  let isCommandAfterSeparator = false;
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index];
    if (word === '--') {
      isCommandAfterSeparator = true;
      index += 1;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    if (word === '--bg') {
      options.isBackground = true;
      usedOptions.push(word);
      continue;
    }
    if (word === '--with-git') {
      options.isWithGit = true;
      usedOptions.push(word);
      continue;
    }
    const optionName = word === '-e' ? '-e' : runValueOptions.find((name) => word === name || word.startsWith(`${name}=`));
    if (optionName === undefined) return { ok: false, error: `unknown option: ${word} (options go before the command; a command that starts with "-" goes after --)` };
    const reading = readOptionValue(words, index, optionName);
    if (reading === null || reading.value === undefined) return { ok: false, error: `${optionName} needs a value` };
    const problem = applyRunOption(options, optionName, reading.value);
    if (problem !== null) return { ok: false, error: problem };
    usedOptions.push(optionName);
    index += reading.consumed - 1;
  }
  const commandWords = words.slice(index);
  if (commandWords.length === 0) return { ok: false, error: 'no command given' };
  if (!isCommandAfterSeparator && subcommandNames.includes(commandWords[0])) return parseOptionsBeforeSubcommand(commandWords[0], commandWords.slice(1), options.runner, usedOptions);
  const joined = joinCommandWords(commandWords);
  return { ok: true, command: { kind: 'run', options, command: joined.command }, ...(joined.note === null ? {} : { note: joined.note }) };
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
    case 'clean':
      return parseCleanArguments(rest);
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
