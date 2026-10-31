/**
 * @description `remoteRun/cliArgs.ts`: the command line — options only BEFORE the command, parsing stops at the first non-option word,
 * a subcommand name is recognised only as the first word (a command that starts with one goes after `--`), the command words are
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
    const command = parseOk(['--runner', 'box1', '--needs=android', '--group', 'emulator', '--timeout', '1h30m', '--with-git', '-e', 'A=1', '-e', 'B=x=y', '--bg', 'yarn', 'e2e']);
    assert.equal(command.kind, 'run');
    if (command.kind !== 'run') return;
    assert.deepEqual(command.options, { runner: 'box1', needs: 'android', group: 'emulator', timeoutSeconds: 5400, isWithGit: true, env: [{ name: 'A', value: '1' }, { name: 'B', value: 'x=y' }], isBackground: true });
    assert.equal(command.command, 'yarn e2e');
  });

  it('defaults: no options set, the timeout left to the default', () => {
    const command = parseOk(['ls']);
    assert.equal(command.kind, 'ls');
    const run = parseOk(['--bg', 'ls', 'build']);
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

  it('exec: --runner before the command, the rest is the command', () => {
    assert.deepEqual(parseOk(['exec', 'ls', 'build/']), { kind: 'exec', runner: null, command: 'ls build/' });
    assert.deepEqual(parseOk(['exec', '--runner', 'box1', 'adb', 'logcat', '-d']), { kind: 'exec', runner: 'box1', command: 'adb logcat -d' });
    assert.deepEqual(parseOk(['exec', '--', 'ls']), { kind: 'exec', runner: null, command: 'ls' });
    assert.match(parseError(['exec']), /needs a command/);
    assert.match(parseError(['exec', '--nope', 'x']), /unknown option for exec/);
  });
});
