/**
 * @description `runnerUtility/simctlGuard.ts`: the `xcrun` in `<root>/bin` that keeps `simctl shutdown | erase | delete all` on a job's own Simulator device (jobs run side by side on
 * a Mac, and `all` would reach the others'). The guard text is run for real under `sh` in front of a stand-in for `/usr/bin/xcrun` (its path is the one variable of the text), so what
 * the real tool would have been given is read off the stand-in: the arguments intact (spaces, order), `--set` kept, a device id in place of `all`, nothing at all when the job has no
 * device; everything else passed through. The rules for writing it (a Mac only, ours only, refreshed when the text changed, removed where it has no use) are pinned beside.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getJobPathDirectories } from '../runnerUtility/execEnv';
import { prepareJobSimulatorGuard } from '../runnerUtility/runnerCommands';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { ensureXcrunGuard, formatGuardLine, renderXcrunGuard, simulatorUdidVariable, xcrunGuardMarker, type GuardDeps } from '../runnerUtility/simctlGuard';

const ownUdid = '11111111-2222-3333-4444-555555555555';
const executableMode = 0o755;
let root = '';
let realXcrun = '';
let callLog = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xcrun-guard-')));
  realXcrun = path.join(root, 'real xcrun');
  callLog = path.join(root, 'calls.log');
  // The stand-in: records its arguments one per line (a call ends with a line of dashes), answers with the exit code FAKE_EXIT.
  fs.writeFileSync(realXcrun, `#!/bin/sh\nfor argument in "$@"; do printf '%s\\n' "$argument" >> '${callLog}'; done\nprintf -- '---\\n' >> '${callLog}'\nexit \${FAKE_EXIT:-0}\n`, { mode: executableMode });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface GuardRun {
  status: number | null;
  stderr: string;
  /** The arguments the real xcrun got, one call after the other; empty when it was not called. */
  realCalls: string[][];
}

function runGuard(args: string[], env: NodeJS.ProcessEnv = {}): GuardRun {
  const guardPath = path.join(root, 'guard xcrun');
  fs.writeFileSync(guardPath, renderXcrunGuard(realXcrun), { mode: executableMode });
  fs.rmSync(callLog, { force: true });
  const environment = { ...process.env, ...env };
  delete environment[simulatorUdidVariable];
  if (env[simulatorUdidVariable] !== undefined) environment[simulatorUdidVariable] = env[simulatorUdidVariable];
  const result = spawnSync(guardPath, args, { encoding: 'utf8', env: environment, timeout: 20_000 });
  const lines = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').split('\n').slice(0, -1) : [];
  const realCalls: string[][] = [[]];
  for (const line of lines) {
    if (line === '---') realCalls.push([]);
    else realCalls[realCalls.length - 1].push(line);
  }
  realCalls.pop();
  return { status: result.status, stderr: result.stderr, realCalls };
}

describe('`simctl <shutdown|erase|delete> all` on a job with a Simulator device of its own', () => {
  for (const subcommand of ['shutdown', 'erase', 'delete']) {
    it(`${subcommand} all becomes ${subcommand} on the job's own device, with a line saying so — the real xcrun is run once`, () => {
      const run = runGuard(['simctl', subcommand, 'all'], { [simulatorUdidVariable]: ownUdid });
      assert.deepEqual(run.realCalls, [['simctl', subcommand, ownUdid]]);
      assert.equal(run.status, 0);
      assert.match(run.stderr, new RegExp(`charness-runner: .xcrun simctl ${subcommand} all. would reach the simulators of other jobs on this machine; it is run on this job's own simulator \\(${ownUdid}\\) only`));
    });
  }

  it('`--set <path>` and `--set=<path>` before the subcommand are kept where they were, and `all` is still replaced', () => {
    assert.deepEqual(runGuard(['simctl', '--set', '/some dir/set', 'shutdown', 'all'], { [simulatorUdidVariable]: ownUdid }).realCalls, [['simctl', '--set', '/some dir/set', 'shutdown', ownUdid]]);
    assert.deepEqual(runGuard(['simctl', '--set=/some dir/set', 'erase', 'all'], { [simulatorUdidVariable]: ownUdid }).realCalls, [['simctl', '--set=/some dir/set', 'erase', ownUdid]]);
  });

  it('the exit status of the real xcrun is the guard\'s', () => {
    assert.equal(runGuard(['simctl', 'shutdown', 'all'], { [simulatorUdidVariable]: ownUdid, FAKE_EXIT: '149' }).status, 149);
  });
});

describe('`simctl <shutdown|erase|delete> all` on a job with no device of its own', () => {
  it('is not run at all — the real xcrun is not called, the status is 0 (the habit succeeds), and a line says why', () => {
    for (const subcommand of ['shutdown', 'erase', 'delete']) {
      const run = runGuard(['simctl', subcommand, 'all']);
      assert.deepEqual(run.realCalls, [], subcommand);
      assert.equal(run.status, 0, subcommand);
      assert.match(run.stderr, new RegExp(`xcrun simctl ${subcommand} all. was not run: other jobs on this machine use their own simulators, and this job has none of its own \\(${simulatorUdidVariable} is not set\\)`), subcommand);
    }
  });

  it('an EMPTY variable is no device either', () => {
    const run = runGuard(['simctl', 'shutdown', 'all'], { [simulatorUdidVariable]: '' });
    assert.deepEqual(run.realCalls, []);
    assert.match(run.stderr, /was not run/);
  });
});

describe('everything else goes to the real xcrun, the arguments intact', () => {
  const cases: Array<[string, string[]]> = [
    ['delete unavailable (the daily cleanup)', ['simctl', 'delete', 'unavailable']],
    ['boot <udid>', ['simctl', 'boot', ownUdid]],
    ['shutdown <udid> (a job\'s own device)', ['simctl', 'shutdown', ownUdid]],
    ['shutdown booted', ['simctl', 'shutdown', 'booted']],
    ['list devices available', ['simctl', 'list', 'devices', 'available']],
    ['create with a name that has a space', ['simctl', 'create', 'my phone', 'com.apple.CoreSimulator.SimDeviceType.iPhone-16']],
    ['--set before a subcommand that is not guarded', ['simctl', '--set', '/x y', 'list']],
    ['a tool other than simctl', ['xcodebuild', '-version']],
    ['xcrun\'s own options', ['--sdk', 'iphonesimulator', '--show-sdk-path']],
    ['no arguments', []],
    ['an `all` that is not the target of a guarded subcommand', ['simctl', 'list', 'all']],
    ['`all` as a name given to create', ['simctl', 'create', 'all', 'type']],
  ];
  for (const [title, args] of cases) {
    it(title, () => {
      for (const env of [{ [simulatorUdidVariable]: ownUdid }, {}]) {
        const run = runGuard(args, env);
        assert.deepEqual(run.realCalls, [args], `${title} (${Object.keys(env).length === 0 ? 'no device' : 'with a device'})`);
        assert.equal(run.stderr, '', 'the guard says nothing about a command it leaves alone');
      }
    });
  }
});

describe('writing the guard into the runner\'s bin', () => {
  let binDirPaths = getRunnerHomePaths('/nonexistent-home');

  beforeEach(() => {
    binDirPaths = getRunnerHomePaths(path.join(root, 'home'));
  });

  function createDeps(overrides: Partial<GuardDeps> = {}): GuardDeps {
    return { platform: 'darwin', realXcrun, checkIsExecutable: (candidate) => candidate === realXcrun, ...overrides };
  }

  const guardPath = (): string => path.join(binDirPaths.binDir, 'xcrun');

  it('a Mac with a real xcrun gets the guard: executable, our marker first, the real path in it — and is told it is current the second time', () => {
    assert.equal(ensureXcrunGuard(binDirPaths, createDeps()), 'installed');
    const text = fs.readFileSync(guardPath(), 'utf8');
    assert.equal(text, renderXcrunGuard(realXcrun));
    assert.equal(text.split('\n')[1], xcrunGuardMarker);
    assert.equal(fs.statSync(guardPath()).mode & 0o777, executableMode);
    assert.equal(ensureXcrunGuard(binDirPaths, createDeps()), 'current');
  });

  it('a guard of an older text (ours, by the marker) is rewritten; one that is not ours is left alone and said so', () => {
    fs.mkdirSync(binDirPaths.binDir, { recursive: true });
    fs.writeFileSync(guardPath(), `#!/bin/sh\n${xcrunGuardMarker}\nexec /usr/bin/xcrun "$@"\n`, { mode: executableMode });
    assert.equal(ensureXcrunGuard(binDirPaths, createDeps()), 'installed');
    assert.equal(fs.readFileSync(guardPath(), 'utf8'), renderXcrunGuard(realXcrun));
    const foreign = '#!/bin/sh\necho the operator\'s own xcrun\n';
    fs.writeFileSync(guardPath(), foreign);
    assert.equal(ensureXcrunGuard(binDirPaths, createDeps()), 'foreign');
    assert.equal(fs.readFileSync(guardPath(), 'utf8'), foreign);
  });

  it('anywhere it has no use — not a Mac, or no real xcrun — nothing is written, and our own guard is taken out again; a file that is not ours stays', () => {
    assert.equal(ensureXcrunGuard(binDirPaths, createDeps({ platform: 'linux' })), 'not-needed');
    assert.equal(fs.existsSync(guardPath()), false);
    ensureXcrunGuard(binDirPaths, createDeps());
    assert.equal(ensureXcrunGuard(binDirPaths, createDeps({ platform: 'linux' })), 'removed');
    assert.equal(fs.existsSync(guardPath()), false);
    ensureXcrunGuard(binDirPaths, createDeps());
    assert.equal(ensureXcrunGuard(binDirPaths, createDeps({ checkIsExecutable: () => false })), 'removed', 'a Mac whose xcrun is gone');
    fs.writeFileSync(guardPath(), 'not ours\n');
    assert.equal(ensureXcrunGuard(binDirPaths, createDeps({ platform: 'linux' })), 'not-needed');
    assert.equal(fs.readFileSync(guardPath(), 'utf8'), 'not ours\n');
  });

  it('is first on a job\'s PATH (the folders of a job and of the login session\'s agent come from one list) — which is what puts it in front of /usr/bin/xcrun', () => {
    assert.equal(getJobPathDirectories(binDirPaths, '/node/bin')[0], binDirPaths.binDir);
    assert.ok(getJobPathDirectories(binDirPaths, '/node/bin').includes('/usr/bin'));
  });

  it('says in one line what it does, or — for a foreign xcrun — that it does not; nothing where there is no guard', () => {
    assert.match(formatGuardLine('installed', binDirPaths) ?? '', /xcrun runs `xcrun simctl shutdown\|erase\|delete all` on a job's own simulator only$/);
    assert.equal(formatGuardLine('current', binDirPaths), formatGuardLine('installed', binDirPaths));
    assert.match(formatGuardLine('foreign', binDirPaths) ?? '', /is not charness-runner's/);
    assert.equal(formatGuardLine('removed', binDirPaths), null);
    assert.equal(formatGuardLine('not-needed', binDirPaths), null);
  });

  describe('as the link and `check` do it (`prepareJobSimulatorGuard`)', () => {
    const io = (): { stdout: string; stderr: string; handle: { stdout: (text: string) => void; stderr: (text: string) => void } } => {
      const captured = { stdout: '', stderr: '', handle: { stdout: (text: string) => { captured.stdout += text; }, stderr: (text: string) => { captured.stderr += text; } } };
      return captured;
    };

    it('writes the guard on a Mac and says so in one line; says nothing, and writes nothing, elsewhere', () => {
      const onMac = io();
      prepareJobSimulatorGuard(binDirPaths, onMac.handle, { platform: 'darwin', realXcrun, checkIsExecutable: () => true });
      assert.equal(fs.readFileSync(path.join(binDirPaths.binDir, 'xcrun'), 'utf8'), renderXcrunGuard(realXcrun));
      assert.equal(onMac.stdout, `${formatGuardLine('installed', binDirPaths)}\n`);
      fs.rmSync(binDirPaths.binDir, { recursive: true, force: true });
      const onLinux = io();
      prepareJobSimulatorGuard(binDirPaths, onLinux.handle, { platform: 'linux', realXcrun, checkIsExecutable: () => true });
      assert.deepEqual([onLinux.stdout, onLinux.stderr, fs.existsSync(binDirPaths.binDir)], ['', '', false]);
    });

    it('a guard that cannot be written is told on stderr and never stops the link', () => {
      fs.mkdirSync(path.dirname(binDirPaths.binDir), { recursive: true });
      fs.writeFileSync(binDirPaths.binDir, 'a file where the bin folder should be');
      const failing = io();
      assert.doesNotThrow(() => prepareJobSimulatorGuard(binDirPaths, failing.handle, { platform: 'darwin', realXcrun, checkIsExecutable: () => true }));
      assert.match(failing.stderr, /^charness-runner: the xcrun guard for jobs could not be written \(.+\)\n$/);
      assert.equal(failing.stdout, '');
    });
  });
});
