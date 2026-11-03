/**
 * @description `remoteRun/cliArgs.ts`: the command line — options only BEFORE the command, parsing stops at the first non-option word,
 * a subcommand name is recognised as the first word (a command that starts with one goes after `--`), a subcommand name that FOLLOWS
 * options is read as the subcommand or refused with the way out — never run as a job of that name — the command words are
 * joined with spaces, durations, and a usage error that says what was wrong.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTimeoutSeconds, maxTimeoutSeconds, parseDuration, parseRemoteRunArgs, type RemoteRunCommand } from '../remoteRun/cliArgs';

function parseOk(words: string[]): RemoteRunCommand {
  const parsed = parseRemoteRunArgs(words);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  return parsed.ok ? parsed.command : { kind: 'help' };
}

function parseError(words: string[]): string {
  const parsed = parseRemoteRunArgs(words);
  assert.equal(parsed.ok, false, `${words.join(' ')} should be refused`);
  return parsed.ok ? '' : parsed.error;
}

describe('running a command', () => {
  it('the words after the options are the command, joined with spaces', () => {
    const command = parseOk(['yarn', 'build', '&&', 'yarn', 'test']);
    assert.equal(command.kind === 'run' && command.command, 'yarn build && yarn test');
    const quoted = parseOk(['yarn build && yarn test']);
    assert.equal(quoted.kind === 'run' && quoted.command, 'yarn build && yarn test');
  });

  it('every option, before the command', () => {
    const command = parseOk(['--runner', 'box1', '--needs=android', '--runner-wait', '20m', '--group', 'emulator', '--timeout', '1h30m', '--with-git', '-e', 'A=1', '-e', 'B=x=y', '--bg', 'yarn', 'e2e']);
    assert.equal(command.kind, 'run');
    if (command.kind !== 'run') return;
    assert.deepEqual(command.options, { runner: 'box1', needs: 'android', runnerWaitSeconds: 1200, group: 'emulator', timeoutSeconds: 5400, isWithGit: true, env: [{ name: 'A', value: '1' }, { name: 'B', value: 'x=y' }], isBackground: true });
    assert.equal(command.command, 'yarn e2e');
  });

  it('--runner-wait: a duration, `0` (never wait), `--runner-wait=…`; left to the default when absent; its name does not shadow --runner', () => {
    const waitOf = (words: string[]): number | null | undefined => {
      const command = parseOk(words);
      return command.kind === 'run' ? command.options.runnerWaitSeconds : undefined;
    };
    assert.equal(waitOf(['--runner-wait', '90s', 'x']), 90);
    assert.equal(waitOf(['--runner-wait=1h', 'x']), 3600);
    assert.equal(waitOf(['--runner-wait', '600', 'x']), 600);
    assert.equal(waitOf(['--runner-wait', '0', 'x']), 0);
    assert.equal(waitOf(['--runner-wait', '0m', 'x']), 0);
    assert.equal(waitOf(['x']), null);
    const both = parseOk(['--runner', 'box1', '--runner-wait', '5m', 'x']);
    assert.ok(both.kind === 'run' && both.options.runner === 'box1' && both.options.runnerWaitSeconds === 300);
  });

  it('defaults: no options set, the timeout left to the default', () => {
    const command = parseOk(['ls']);
    assert.equal(command.kind, 'ls');
    const run = parseOk(['--bg', '--', 'ls', 'build']);
    assert.equal(run.kind === 'run' && run.command, 'ls build');
    assert.equal(run.kind === 'run' && run.options.timeoutSeconds, null);
    assert.equal(defaultTimeoutSeconds, 3 * 3600);
  });

  it('parsing stops at the first non-option word: later dashes belong to the command', () => {
    const command = parseOk(['--bg', 'yarn', 'test', '--runInBand', '-e', 'X=1']);
    assert.equal(command.kind === 'run' && command.command, 'yarn test --runInBand -e X=1');
    assert.equal(command.kind === 'run' && command.options.env.length, 0);
  });

  it('a command that starts with a subcommand name goes after --', () => {
    const command = parseOk(['--', 'ls', 'build']);
    assert.equal(command.kind === 'run' && command.command, 'ls build');
    const withOptions = parseOk(['--bg', '--', 'status', '-v']);
    assert.equal(withOptions.kind === 'run' && withOptions.command, 'status -v');
  });

  it('an unknown option before the command is an error naming it and the way out', () => {
    assert.match(parseError(['--nope', 'ls']), /unknown option: --nope.*after --/);
  });

  it('refuses a missing command, a missing or bad option value, a bad env pair', () => {
    assert.match(parseError(['--bg']), /no command/);
    assert.match(parseError(['--runner']), /--runner needs a value/);
    assert.match(parseError(['--needs', 'gpu', 'x']), /--needs must be one of: android, ios, docker, playwright/);
    assert.match(parseError(['--runner-wait', 'soon', 'x']), /--runner-wait needs a duration/);
    assert.match(parseError(['--runner-wait']), /--runner-wait needs a value/);
    assert.match(parseError(['--runner-wait', '200h', 'x']), /--runner-wait is at most 7 days/);
    assert.match(parseError(['--timeout', 'soon', 'x']), /--timeout needs a duration/);
    assert.match(parseError(['--timeout', '169h', 'x']), /at most 7 days/);
    assert.match(parseError(['--runner', '--bg', 'x']), /--runner needs a runner name/);
    assert.match(parseError(['--group', '-bad', 'x']), /--group/);
    assert.match(parseError(['-e', 'NOEQUALS', 'x']), /NAME=VALUE/);
    assert.match(parseError(['-e', '1BAD=x', 'x']), /NAME=VALUE/);
    assert.match(parseError(['-e', 'A=line\nbreak', 'x']), /newline/);
  });
});

describe('the timeout ceiling', () => {
  it('a week is the most: a longer delay overflows Node\'s timers and would kill the job at once', () => {
    const week = parseRemoteRunArgs(['--timeout', '168h', 'x']);
    assert.equal(week.ok && week.command.kind === 'run' && week.command.options.timeoutSeconds, 7 * 24 * 3600);
    assert.equal(maxTimeoutSeconds * 1000 < 2 ** 31, true);
    assert.equal(parseRemoteRunArgs(['--timeout', '169h', 'x']).ok, false);
    assert.equal(parseRemoteRunArgs(['--timeout', '99999999999h', 'x']).ok, false);
  });
});

describe('parseDuration', () => {
  it('reads seconds, minutes, hours and their combinations', () => {
    assert.equal(parseDuration('45s'), 45);
    assert.equal(parseDuration('90m'), 5400);
    assert.equal(parseDuration('3h'), 10800);
    assert.equal(parseDuration('1h30m'), 5400);
    assert.equal(parseDuration('600'), 600);
    assert.equal(parseDuration('1h1m1s'), 3661);
  });

  it('refuses zero, words, signs and anything with a gap', () => {
    for (const text of ['0', '0m', '', 'h', '1x', '-5m', '1.5h', '1h 30m', 'abc']) assert.equal(parseDuration(text), null, text);
  });
});

describe('subcommands', () => {
  const jobId = 'box1-abc234';

  it('help: no arguments, --help, -h', () => {
    for (const words of [[], ['--help'], ['-h'], ['help']]) assert.equal(parseOk(words).kind, 'help');
  });

  it('ls, ls --all, runners', () => {
    assert.deepEqual(parseOk(['ls']), { kind: 'ls', isAll: false });
    assert.deepEqual(parseOk(['ls', '--all']), { kind: 'ls', isAll: true });
    assert.deepEqual(parseOk(['runners']), { kind: 'runners' });
    assert.match(parseError(['ls', '--nope']), /unknown argument for ls/);
    assert.match(parseError(['runners', 'x']), /no arguments/);
  });

  it('status, wait, kill, fetch take exactly one job id', () => {
    for (const name of ['status', 'wait', 'kill', 'fetch'] as const) {
      assert.deepEqual(parseOk([name, jobId]), { kind: name, jobId });
      assert.match(parseError([name]), /needs a job id/);
      assert.match(parseError([name, 'not-an-id']), /is not a job id/);
      assert.match(parseError([name, jobId, 'extra']), /one job id/);
    }
  });

  it('logs: -f and --tail N in any order around the id', () => {
    assert.deepEqual(parseOk(['logs', jobId]), { kind: 'logs', jobId, isFollow: false, tail: null });
    assert.deepEqual(parseOk(['logs', jobId, '-f', '--tail', '20']), { kind: 'logs', jobId, isFollow: true, tail: 20 });
    assert.deepEqual(parseOk(['logs', '--tail=5', '-f', jobId]), { kind: 'logs', jobId, isFollow: true, tail: 5 });
    assert.match(parseError(['logs', jobId, '--tail', '0']), /--tail needs/);
    assert.match(parseError(['logs', jobId, '--nope']), /unknown option for logs/);
  });

  it('options BEFORE exec: --runner is understood (the exec runs on that runner), the other run options are refused — exec is never run as a shell builtin job', () => {
    assert.deepEqual(parseOk(['--runner', 'box1', 'exec', 'ls', 'build/']), { kind: 'exec', runner: 'box1', command: 'ls build/' });
    assert.deepEqual(parseOk(['--runner=box1', 'exec', 'adb', 'logcat', '-d']), { kind: 'exec', runner: 'box1', command: 'adb logcat -d' });
    assert.deepEqual(parseOk(['--runner', 'box1', 'exec', '--runner', 'box1', 'ls']), { kind: 'exec', runner: 'box1', command: 'ls' });
    assert.deepEqual(parseOk(['--runner', 'box1', 'exec', '--', 'ls']), { kind: 'exec', runner: 'box1', command: 'ls' });
    assert.match(parseError(['--runner', 'box1', 'exec', '--runner', 'box2', 'ls']), /two runners for exec: box1 before it, box2 after it/);
    assert.match(parseError(['--runner', 'box1', 'exec']), /exec needs a command/);
    for (const option of [['--bg'], ['--with-git'], ['--timeout', '1h'], ['--needs', 'ios'], ['--group', 'emulator'], ['--runner-wait', '5m'], ['-e', 'A=1']]) {
      const message = parseError([...option, 'exec', 'ls']);
      assert.match(message, new RegExp(`^${option[0]} does not apply to exec — before exec only --runner is understood`), message);
      assert.match(message, /called "exec" goes after -- \(charness remote-run \[options\] -- exec/);
    }
    assert.match(parseError(['--runner', 'box1', '--bg', 'exec', 'ls']), /^--bg does not apply to exec/);
  });

  it('options before any other subcommand name are refused with the way out, and `--` runs a command that is called so', () => {
    for (const name of ['ls', 'runners', 'logs', 'status', 'wait', 'kill', 'fetch', 'help']) {
      const message = parseError(['--runner', 'box1', name, 'x']);
      assert.match(message, new RegExp(`^"${name}" is a remote-run subcommand and subcommands come first \\(charness remote-run ${name} …\\)`), message);
      assert.match(message, new RegExp(`called "${name}" goes after -- \\(charness remote-run \\[options\\] -- ${name} …\\)`), message);
      const asJob = parseOk(['--runner', 'box1', '--', name, 'x']);
      assert.ok(asJob.kind === 'run' && asJob.command === `${name} x` && asJob.options.runner === 'box1');
    }
    assert.match(parseError(['--bg', 'ls', 'build']), /"ls" is a remote-run subcommand/);
  });

  it('a subcommand name that is not the first word of the command is just part of the command', () => {
    const command = parseOk(['--bg', 'yarn', 'exec', 'ls']);
    assert.ok(command.kind === 'run' && command.command === 'yarn exec ls');
    const hyphenated = parseOk(['--runner', 'box1', 'ls-files']);
    assert.ok(hyphenated.kind === 'run' && hyphenated.command === 'ls-files');
  });

  it('exec: --runner before the command, the rest is the command', () => {
    assert.deepEqual(parseOk(['exec', 'ls', 'build/']), { kind: 'exec', runner: null, command: 'ls build/' });
    assert.deepEqual(parseOk(['exec', '--runner', 'box1', 'adb', 'logcat', '-d']), { kind: 'exec', runner: 'box1', command: 'adb logcat -d' });
    assert.deepEqual(parseOk(['exec', '--', 'ls']), { kind: 'exec', runner: null, command: 'ls' });
    assert.match(parseError(['exec']), /needs a command/);
    assert.match(parseError(['exec', '--nope', 'x']), /unknown option for exec/);
  });
});
