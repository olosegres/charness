/**
 * @description `remoteRun/cliArgs.ts`: the command line — options only BEFORE the command, parsing stops at the first non-option word,
 * a subcommand name is recognised as the first word (a command that starts with one goes after `--`), a subcommand name that FOLLOWS
 * options is read as the subcommand or refused with the way out — never run as a job of that name — the command words are
 * joined with spaces (except a shell's `-c <script>`, whose script stays ONE word), durations, and a usage error that says what was wrong.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    const command = parseOk(['--runner', 'box1', '--needs=android', '--runner-wait', '20m', '--group', 'emulator', '--timeout', '1h30m', '--with-git', '--send', '.env.test', '--send=keys/*.pem', '-e', 'A=1', '-e', 'B=x=y', '--bg', 'yarn', 'e2e']);
    assert.equal(command.kind, 'run');
    if (command.kind !== 'run') return;
    assert.deepEqual(command.options, { runner: 'box1', needs: 'android', runnerWaitSeconds: 1200, group: 'emulator', timeoutSeconds: 5400, isWithGit: true, send: ['.env.test', 'keys/*.pem'], env: [{ name: 'A', value: '1' }, { name: 'B', value: 'x=y' }], isBackground: true });
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

  it('--send: one pattern per option, repeatable, kept in order; a bad pattern or none is an error; before exec it does not apply', () => {
    const command = parseOk(['--send', '.env', '--send', 'cfg/*.pem', 'yarn', 'test']);
    assert.ok(command.kind === 'run' && command.options.send.join('|') === '.env|cfg/*.pem');
    const noneGiven = parseOk(['yarn', 'test']);
    assert.ok(noneGiven.kind === 'run' && noneGiven.options.send.length === 0);
    assert.match(parseError(['--send']), /--send needs a value/);
    assert.match(parseError(['--send', '/etc/passwd', 'x']), /--send pattern /);
    assert.match(parseError(['--send', '../up', 'x']), /--send pattern /);
    assert.match(parseError(['--send', '.env', 'exec', 'ls']), /^--send does not apply to exec/);
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

  it('clean: no word = the project this is run in, one word = that project copy\'s name; anything else is refused with the reason', () => {
    assert.deepEqual(parseOk(['clean']), { kind: 'clean', slug: null });
    assert.deepEqual(parseOk(['clean', 'myapp-0a1b2c3d4e']), { kind: 'clean', slug: 'myapp-0a1b2c3d4e' });
    assert.deepEqual(parseOk(['clean', 'my.app_1-0a1b2c3d4e']), { kind: 'clean', slug: 'my.app_1-0a1b2c3d4e' });
    assert.match(parseError(['clean', 'a', 'b']), /clean takes one project copy name, got extra: b/);
    assert.match(parseError(['clean', '--all']), /unknown option for clean: --all/);
    for (const bad of ['../x', 'a/b', '.hidden', 'a b', 'x'.repeat(81)]) assert.match(parseError(['clean', bad]), /is not the name of a project copy/, bad);
  });

  it('a job that is simply called «clean» goes after -- like any subcommand name; options before it are refused with the way out', () => {
    const asJob = parseOk(['--bg', '--', 'clean']);
    assert.ok(asJob.kind === 'run' && asJob.command === 'clean' && asJob.options.isBackground);
    assert.match(parseError(['--bg', 'clean']), /^"clean" is a remote-run subcommand and subcommands come first/);
    assert.match(parseError(['--runner', 'box1', 'clean']), /called "clean" goes after --/);
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

/** The command string of a `run` or an `exec` that was given these words. */
function parseCommandText(words: string[]): string {
  const command = parseOk(words);
  assert.ok(command.kind === 'run' || command.kind === 'exec', `${words.join(' ')} should be a command`);
  return command.kind === 'run' || command.kind === 'exec' ? command.command : '';
}

describe('a shell invocation `<shell> -c <script>`: the script is ONE word, so it stays one when the words are joined', () => {
  it('bash -c, sh -c, zsh -c, dash -c, ksh -c and a shell given by path: the script and what follows it are quoted', () => {
    assert.equal(parseCommandText(['bash', '-c', 'cd projects/app && yarn e2e -- flow.e2e.ts']), "bash -c 'cd projects/app && yarn e2e -- flow.e2e.ts'");
    assert.equal(parseCommandText(['sh', '-c', 'cd a && ls']), "sh -c 'cd a && ls'");
    assert.equal(parseCommandText(['zsh', '-c', 'echo $HOME']), "zsh -c 'echo $HOME'");
    assert.equal(parseCommandText(['dash', '-c', 'a; b']), "dash -c 'a; b'");
    assert.equal(parseCommandText(['ksh', '-c', 'a | b']), "ksh -c 'a | b'");
    assert.equal(parseCommandText(['/bin/bash', '-c', 'cd a && ls']), "/bin/bash -c 'cd a && ls'");
  });

  it('a combined flag that holds c (-lc, -ec, -xc) is the same; the words after the script (the shell\'s $0, $1 …) are quoted one by one', () => {
    assert.equal(parseCommandText(['bash', '-lc', 'cd a && ls']), "bash -lc 'cd a && ls'");
    assert.equal(parseCommandText(['sh', '-ec', 'false; true']), "sh -ec 'false; true'");
    assert.equal(parseCommandText(['bash', '-c', 'echo "$0 $1"', 'name', 'two words']), `bash -c 'echo "$0 $1"' name 'two words'`);
  });

  it('the shell\'s own options before `-c` (`-e`, `--login`, `-o pipefail`, `-O extglob`) do not hide the script: they stay as they are and the script is quoted', () => {
    assert.equal(parseCommandText(['bash', '-e', '-c', 'cd a && ls']), "bash -e -c 'cd a && ls'");
    assert.equal(parseCommandText(['bash', '--login', '-c', 'cd a && ls']), "bash --login -c 'cd a && ls'");
    assert.equal(parseCommandText(['bash', '-o', 'pipefail', '-c', 'cd a && ls']), "bash -o pipefail -c 'cd a && ls'");
    assert.equal(parseCommandText(['bash', '-e', '-o', 'pipefail', '-lc', 'cd a | ls']), "bash -e -o pipefail -lc 'cd a | ls'");
    assert.equal(parseCommandText(['bash', '-O', 'extglob', '-c', 'ls']), 'bash -O extglob -c ls');
    assert.equal(parseCommandText(['exec', 'bash', '-o', 'pipefail', '-c', 'cd a && ls']), "bash -o pipefail -c 'cd a && ls'");
    // The value of `-o` is no flag, whatever it looks like; a word that is no option ends the search (`bash script.sh -c x` runs the script).
    assert.equal(parseCommandText(['bash', '-o', 'errexit', 'script.sh', '-c', 'x y']), 'bash -o errexit script.sh -c x y');
    assert.equal(parseCommandText(['bash', '-e', '--', '-c', 'x y']), 'bash -e -- -c x y');
  });

  it('a single quote inside the script survives, and a script that needs no quoting is left as it is', () => {
    const withQuote = parseCommandText(['bash', '-c', "echo 'a  b'"]);
    assert.equal(spawnSync('bash', ['-c', withQuote], { encoding: 'utf8' }).stdout, 'a  b\n');
    assert.equal(parseCommandText(['bash', '-c', 'ls']), 'bash -c ls');
  });

  it('exec reads it the same way, and options before the command are still options', () => {
    assert.equal(parseCommandText(['exec', 'bash', '-c', 'cd a && ls']), "bash -c 'cd a && ls'");
    assert.equal(parseCommandText(['exec', '--runner', 'box1', 'sh', '-c', 'cd a && ls']), "sh -c 'cd a && ls'");
    const job = parseOk(['--bg', '--needs', 'ios', '--send', '.env.test', 'bash', '-c', 'cd a && ls']);
    assert.ok(job.kind === 'run' && job.command === "bash -c 'cd a && ls'" && job.options.needs === 'ios' && job.options.isBackground);
  });

  it('everything else keeps the documented rule — the words joined with spaces', () => {
    assert.equal(parseCommandText(['bash', 'script.sh', '-c', 'x y']), 'bash script.sh -c x y');
    assert.equal(parseCommandText(['bash', '-c']), 'bash -c');
    assert.equal(parseCommandText(['bash', '-n', 'script.sh']), 'bash -n script.sh');
    assert.equal(parseCommandText(['env', 'bash', '-c', 'cd a && ls']), 'env bash -c cd a && ls');
    assert.equal(parseCommandText(['yarn', 'e2e', '-c', 'a b']), 'yarn e2e -c a b');
    assert.equal(parseCommandText(['mybash', '-c', 'cd a && ls']), 'mybash -c cd a && ls');
    assert.equal(parseCommandText(['bash -c "cd a && ls"']), 'bash -c "cd a && ls"');
    assert.equal(parseCommandText(['cd a && ls']), 'cd a && ls');
  });

  it('a word after the first that the runner would read again gets ONE note for stderr; a script in the first word, a quoted shell script and a command with nothing to re-read get none', () => {
    const rereadCommandNote = 'the words are joined with spaces and read again on the runner — pass the whole command as one quoted word';
    const noteOf = (words: string[]): string | undefined => {
      const parsed = parseRemoteRunArgs(words);
      assert.ok(parsed.ok, words.join(' '));
      return parsed.ok ? parsed.note : undefined;
    };
    assert.equal(noteOf(['nice', '-n', '19', 'bash', '-c', 'cd a && ls']), rereadCommandNote);
    assert.equal(noteOf(['env', 'bash', '-c', 'cd a && ls']), rereadCommandNote);
    assert.equal(noteOf(['timeout', '600', 'bash', '-c', 'ls | wc']), rereadCommandNote);
    assert.equal(noteOf(['python3', '-c', 'print(1)']), rereadCommandNote);
    assert.equal(noteOf(['yarn', 'e2e', '-t', 'a b']), rereadCommandNote);
    assert.equal(noteOf(['exec', 'nice', 'bash', '-c', 'cd a && ls']), rereadCommandNote);
    assert.equal(noteOf(['--runner', 'box1', 'exec', 'nice', 'bash', '-c', 'cd a && ls']), rereadCommandNote);
    assert.equal(noteOf(['bash', '-c', 'cd a && ls']), undefined, 'quoted for you');
    assert.equal(noteOf(['bash', '-o', 'pipefail', '-c', 'cd a && ls']), undefined, 'quoted for you');
    assert.equal(noteOf(['yarn build && yarn test']), undefined, 'one word: the documented way');
    assert.equal(noteOf(['yarn', 'build', '--', '--watch=false']), undefined);
    assert.equal(noteOf(['echo', 'build/']), undefined);
  });

  it('run on a real shell (the runner runs the command text with `bash -c`): `cd` and the chain after it happen INSIDE the script — the job of 2026-11-09 ran `yarn …` in the project root instead', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'remote-run-words-')));
    try {
      mkdirSync(path.join(root, 'projects', 'app'), { recursive: true });
      const commandText = parseCommandText(['bash', '-c', 'cd projects/app && pwd && echo "[$0] [$#]"']);
      const ran = spawnSync('bash', ['-c', commandText], { cwd: root, encoding: 'utf8' });
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(ran.stdout, `${path.join(root, 'projects', 'app')}\n[bash] [0]\n`);
      const withArguments = parseCommandText(['bash', '-c', 'echo "$0|$1|$2"', 'zero', 'one two', "it's"]);
      assert.equal(spawnSync('bash', ['-c', withArguments], { cwd: root, encoding: 'utf8' }).stdout, "zero|one two|it's\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
