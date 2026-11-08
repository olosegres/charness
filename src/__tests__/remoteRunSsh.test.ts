/**
 * @description `remoteRun/ssh.ts`: the ssh argument lists and the quoting for the remote shell. Non-interactive always (`BatchMode`),
 * host keys checked as the operator's config says (never `StrictHostKeyChecking=no`), the operator's own options first (ssh keeps the
 * first value), one master per runner — and the quoting proven with a REAL shell: whatever the words are, the remote shell reads them back
 * as the same words.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import {
  buildRsyncSshCommand,
  buildRunnerScriptCommand,
  buildScriptExistsCommand,
  buildScriptUploadCommand,
  buildSshArgs,
  getRemoteRunCacheDir,
  joinShellWords,
  quoteRemotePath,
  quoteShellWord,
} from '../remoteRun/ssh';

const cacheDir = '/home/user/.cache/charness/remote-run';

describe('buildSshArgs', () => {
  it('is non-interactive, keeps the connection alive, multiplexes over one master', () => {
    const args = buildSshArgs({}, cacheDir);
    assert.ok(args.join(' ').includes('BatchMode=yes'));
    assert.ok(args.join(' ').includes('ConnectTimeout=15'));
    assert.ok(args.join(' ').includes('ServerAliveInterval=15'));
    assert.ok(args.join(' ').includes('ServerAliveCountMax=3'));
    assert.ok(args.join(' ').includes('ControlMaster=auto'));
    assert.ok(args.join(' ').includes(`ControlPath=${cacheDir}/ssh/%C`));
    assert.ok(args.join(' ').includes('ControlPersist=60'));
  });

  it('never turns host key checking off', () => {
    assert.ok(!buildSshArgs({}, cacheDir).join(' ').includes('StrictHostKeyChecking'));
  });

  it('puts the operator\'s options first: ssh keeps the first value of an option', () => {
    const args = buildSshArgs({ sshOptions: ['-i', '/k/id', '-p', '2222', '-o', 'ConnectTimeout=5'] }, cacheDir);
    assert.deepEqual(args.slice(0, 6), ['-i', '/k/id', '-p', '2222', '-o', 'ConnectTimeout=5']);
    assert.ok(args.indexOf('ConnectTimeout=5') < args.indexOf('ConnectTimeout=15'));
  });

  it('a cache path too long for a unix socket turns the multiplexing off instead of failing', () => {
    const longCache = `/${'x'.repeat(80)}`;
    const args = buildSshArgs({}, longCache).join(' ');
    assert.ok(args.includes('ControlMaster=no'));
    assert.ok(!args.includes('ControlPath'));
  });

  describe('the length of the ControlPath', () => {
    /** A cache dir whose `ssh` folder (the ControlPath's directory) is exactly `length` characters long. */
    const getCacheDirWithControlDirectoryLength = (length: number): string => `/${'x'.repeat(length - '/ssh'.length - 1)}`;
    const longestUsableControlDirectory = 45;

    it('ssh binds `<ControlPath>.<16 characters>` first: a folder of 45 characters (45 + / + 40 + 17 = 103, macOS\'s sun_path less its NUL) still multiplexes', () => {
      const cache = getCacheDirWithControlDirectoryLength(longestUsableControlDirectory);
      assert.equal(`${cache}/ssh`.length, longestUsableControlDirectory);
      assert.ok(buildSshArgs({}, cache).includes('ControlMaster=auto'));
    });

    it('one character more turns the multiplexing off - the call then goes on over a connection of its own instead of failing at the temporary socket (255)', () => {
      const cache = getCacheDirWithControlDirectoryLength(longestUsableControlDirectory + 1);
      assert.equal(`${cache}/ssh`.length, longestUsableControlDirectory + 1);
      const args = buildSshArgs({}, cache);
      assert.ok(args.includes('ControlMaster=no'));
      assert.ok(!args.join(' ').includes('ControlPath'));
    });

    it('the folders that used to pass at 50 to 59 characters (and failed every ssh call to a runner) are off now', () => {
      for (const length of [50, 55, 59]) assert.ok(buildSshArgs({}, getCacheDirWithControlDirectoryLength(length)).includes('ControlMaster=no'), `${length}`);
    });
  });

  it('a cache path with whitespace is double-quoted, so ssh reads the ControlPath as one word (unquoted it is «extra arguments at end of line»)', () => {
    const spacedCache = '/home/my user/.cache/charness/remote-run';
    const args = buildSshArgs({}, spacedCache);
    assert.ok(args.includes(`ControlPath="${spacedCache}/ssh/%C"`));
    assert.ok(args.includes('ControlMaster=auto'));
  });

  it('a literal % in the cache path is written %% — ssh expands %-tokens in a ControlPath', () => {
    const args = buildSshArgs({}, '/home/100%/.cache/charness/remote-run');
    assert.ok(args.includes('ControlPath=/home/100%%/.cache/charness/remote-run/ssh/%C'));
  });

  it('a cache path that cannot be quoted for ssh and rsync turns the multiplexing off instead of failing', () => {
    for (const unsafe of ["/home/it's", '/home/a"b', '/home/a\\b', '/home/a$b', '/home/a`b', '/home/a\nb']) {
      const args = buildSshArgs({}, `${unsafe}/.cache`);
      assert.ok(args.includes('ControlMaster=no'), unsafe);
      assert.ok(!args.join(' ').includes('ControlPath'), unsafe);
    }
  });

  describe('read by the real ssh and the real shell', { skip: spawnSync('ssh', ['-V']).error === undefined ? false : 'ssh is not installed' }, () => {
    /** The `controlpath` line of `ssh -G`: where ssh would really put the socket (`%C` expanded to its hash). */
    function readControlPath(cache: string): string {
      const printed = spawnSync('ssh', ['-G', '-F', '/dev/null', ...buildSshArgs({}, cache), 'host.example'], { encoding: 'utf8' });
      assert.equal(printed.status, 0, printed.stderr);
      const line = printed.stdout.split('\n').find((candidate) => candidate.startsWith('controlpath '));
      assert.ok(line, printed.stdout);
      return line.slice('controlpath '.length);
    }

    it('a cache path with whitespace or a % gives one socket path in that very folder', () => {
      assert.match(readControlPath('/home/my user/.cache/charness/remote-run'), /^\/home\/my user\/\.cache\/charness\/remote-run\/ssh\/[0-9a-f]{40}$/);
      assert.match(readControlPath('/home/100%/.cache/charness/remote-run'), /^\/home\/100%\/\.cache\/charness\/remote-run\/ssh\/[0-9a-f]{40}$/);
    });

    it('the `-e` string of rsync splits back into the same words, the quoted ControlPath among them', () => {
      const spacedCache = '/home/my user/.cache/charness/remote-run';
      const rsyncCommand = buildRsyncSshCommand({ sshOptions: ['-p', '2222'] }, spacedCache);
      const printed = spawnSync('sh', ['-c', `for word in ${rsyncCommand}; do printf '%s\\n' "$word"; done`], { encoding: 'utf8' }).stdout.split('\n');
      assert.deepEqual(printed.slice(0, -1), ['ssh', ...buildSshArgs({ sshOptions: ['-p', '2222'] }, spacedCache)]);
    });
  });

  it('the rsync -e command is ssh with the same options', () => {
    assert.equal(buildRsyncSshCommand({ sshOptions: ['-p', '2222'] }, cacheDir), `ssh -p 2222 -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=auto -o ControlPath=${cacheDir}/ssh/%C -o ControlPersist=60`);
  });
});

describe('getRemoteRunCacheDir', () => {
  it('is $XDG_CACHE_HOME/charness/remote-run, else ~/.cache/charness/remote-run', () => {
    assert.equal(getRemoteRunCacheDir({ XDG_CACHE_HOME: '/xdg' }, '/home/u'), '/xdg/charness/remote-run');
    assert.equal(getRemoteRunCacheDir({}, '/home/u'), '/home/u/.cache/charness/remote-run');
    assert.equal(getRemoteRunCacheDir({ XDG_CACHE_HOME: '' }, '/home/u'), '/home/u/.cache/charness/remote-run');
  });
});

describe('quoting for the remote shell', () => {
  const awkwardWords = ['plain', 'with space', "it's", 'a"b', '$HOME', '`id`', '; rm -rf /', '*', '~', '~/x', '', 'new\nline', 'tab\there', '-n', '&&', 'ünï', '\\'];

  it('a real shell reads every word back unchanged', () => {
    const result = spawnSync('sh', ['-c', `printf '%s\\0' ${joinShellWords(awkwardWords)}`], { encoding: 'buffer' });
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout.toString('utf8').split('\0').slice(0, -1), awkwardWords);
  });

  it('leaves a plain word alone and quotes anything with a shell meaning', () => {
    assert.equal(quoteShellWord('plain-word_1.2/x'), 'plain-word_1.2/x');
    assert.equal(quoteShellWord('a b'), "'a b'");
    assert.equal(quoteShellWord("it's"), `'it'\\''s'`);
    assert.equal(quoteShellWord(''), "''");
    assert.notEqual(quoteShellWord('~'), '~', 'a bare ~ in an argument is not left for the remote shell to expand');
  });

  it('a path keeps its leading ~ for the REMOTE shell to expand and quotes the rest', () => {
    assert.equal(quoteRemotePath('~'), '~');
    assert.equal(quoteRemotePath('~/charness runner'), "~/'charness runner'");
    assert.equal(quoteRemotePath('/abs/path'), '/abs/path');
    assert.equal(quoteRemotePath('/abs/with space'), "'/abs/with space'");
    const home = spawnSync('sh', ['-c', `printf '%s' ${quoteRemotePath('~/dir with space')}`], { encoding: 'utf8', env: { ...process.env, HOME: '/home/someone' } });
    assert.equal(home.stdout, '/home/someone/dir with space');
  });
});

describe('the commands run on the runner', () => {
  const runner = { workDir: '~/charness-runner', pueue: { bin: '/home/runner/.local/bin/pueue', config: '/tmp/p ueue.yml' } };

  it('a script call: Pueue through the environment, the work dir first, every argument quoted', () => {
    const command = buildRunnerScriptCommand({ runner, scriptName: 'runner-abc12345.sh', subcommand: 'prepare', args: ['app-1', 'box1-abc234', 'default=2'] });
    assert.equal(command, "PUEUE_BIN=/home/runner/.local/bin/pueue PUEUE_CONFIG='/tmp/p ueue.yml' bash ~/charness-runner/bin/runner-abc12345.sh prepare ~/charness-runner app-1 box1-abc234 default=2");
  });

  it('the runner\'s disk upkeep settings go through the environment too (numbers only) — and only the ones its config sets', () => {
    const both = buildRunnerScriptCommand({ runner: { workDir: '/w', minFreeGb: 40, copyMaxIdleDays: 7 }, scriptName: 's.sh', subcommand: 'prepare', args: [] });
    assert.equal(both, 'REMOTE_RUN_MIN_FREE_GB=40 REMOTE_RUN_COPY_MAX_IDLE_DAYS=7 bash /w/bin/s.sh prepare /w');
    const zero = buildRunnerScriptCommand({ runner: { workDir: '/w', minFreeGb: 0 }, scriptName: 's.sh', subcommand: 'prune', args: [] });
    assert.equal(zero, 'REMOTE_RUN_MIN_FREE_GB=0 bash /w/bin/s.sh prune /w', '0 (no free-space target) is a setting, not an absence');
  });

  it('a call without Pueue settings has no environment prefix; an argument that would break a shell is quoted', () => {
    const command = buildRunnerScriptCommand({ runner: { workDir: '/w' }, scriptName: 's.sh', subcommand: 'exec', args: ['slug', '', '4000', 'echo "a b" && ls; $(x)'] });
    assert.equal(command, `bash /w/bin/s.sh exec /w slug '' 4000 'echo "a b" && ls; $(x)'`);
  });

  it('the upload command writes a temp file and renames it, so a half upload is never run', () => {
    const command = buildScriptUploadCommand({ workDir: '/w' }, 'runner-1.sh');
    assert.match(command, /^mkdir -p \/w\/bin && cat > \/w\/bin\/\.runner-1\.sh\.\$\$ && chmod 755 \/w\/bin\/\.runner-1\.sh\.\$\$ && mv -f \/w\/bin\/\.runner-1\.sh\.\$\$ \/w\/bin\/runner-1\.sh$/);
    assert.equal(buildScriptExistsCommand({ workDir: '/w' }, 'runner-1.sh'), 'test -f /w/bin/runner-1.sh');
  });
});
