/**
 * @description `remoteRun/runner.sh`, jobs of different projects side by side: what each PROJECT COPY is given once and keeps — a number (`p/<slug>/index`, the lowest that no other copy holds, under
 * `tmp/index.lock`), and from it a block of ports (`REMOTE_RUN_PORT_BASE` = 20000 + 100 × number) and its own TMPDIR (`<work>/t/<number>`, empty for a new copy). The three reach the steps of a job
 * through `$jd/runner-env`: TMPDIR BEFORE the job's own `-e` lines (the job may take it back), REMOTE_RUN_* AFTER them (it may not); `exec` gets none. A copy that is removed (`clean`, the prune) gives
 * its number back at once, takes its TMPDIR with it, and puts its Simulator device on the retired list; a copy that is in use does none of that. The gui agent's side of the env contract is
 * `remoteRunGuiSession.test.ts`; a job's own Simulator device is `remoteRunRunnerScriptSimulator.test.ts`.
 *
 * rsync is needed for the jobs (the apply step): a local run without it is SKIPPED with the reason, CI installs it and fails without.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkIsRsyncAvailable, createRunnerState, getRunEnvironment, runJob, startJob, waitForJobExit, waitUntil, type JobSpec, type RunnerState } from './remoteRunRunnerJobKit';
import { scriptPath, startRunnerStandIn, stopRunnerStandIns, writeFile } from './remoteRunRunnerScriptKit';

const isCi = process.env.CI === 'true' || process.env.CI === '1';
const rsyncSkip = !checkIsRsyncAvailable() && !isCi ? 'rsync is not installed here (CI installs it)' : false;
const maxCopyIndexes = 100;

let root = '';
let state: RunnerState;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'copies-')));
  state = createRunnerState(root, null);
});
afterEach(() => {
  stopRunnerStandIns();
  fs.rmSync(root, { recursive: true, force: true });
});

interface SourcedRun {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** The script's functions, `source`d in a process of their own with the globals of one project copy set the way `cmd_job` has them. */
function runSourced(slugName: string, body: string, env: NodeJS.ProcessEnv = {}): SourcedRun {
  const program = [`source ${scriptPath}`, `work=${state.workDir}; slug=${slugName}; proj="$work/p/$slug"; job=; mkdir -p "$proj"`, body].join('\n');
  const result = spawnSync('bash', ['-c', program], { encoding: 'utf8', env: getRunEnvironment(env), timeout: 60_000 });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** The number a project copy is given (empty when none), and what the script said. */
function allocate(slugName: string, env: NodeJS.ProcessEnv = {}, before = ''): { index: string; said: string } {
  const run = runSourced(slugName, `${before}\nensure_copy_index; echo "index=$copy_index"`, env);
  return { index: /^index=(.*)$/m.exec(run.stdout)?.[1] ?? 'unreadable', said: run.stdout.split('\n').filter((line) => line.startsWith('remote-run: ')).join('\n') };
}

function runScript(args: string[]): SourcedRun {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: getRunEnvironment(), timeout: 60_000 });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function readIndexFile(slugName: string): string | null {
  const file = path.join(state.workDir, 'p', slugName, 'index');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
}

describe('the number of a project copy', () => {
  it('is the lowest that no other copy holds, is written down in the copy, and is kept: the same copy gets the same number every time', () => {
    assert.equal(allocate('app-aaaaaaaaaa').index, '0');
    assert.equal(allocate('app-bbbbbbbbbb').index, '1');
    assert.equal(allocate('app-cccccccccc').index, '2');
    assert.equal(readIndexFile('app-bbbbbbbbbb'), '1');
    assert.equal(allocate('app-bbbbbbbbbb').index, '1', 'a second job of the copy');
    assert.equal(allocate('app-aaaaaaaaaa').index, '0');
    assert.equal(fs.existsSync(path.join(state.workDir, 'tmp', 'index.lock')), false, 'the lock is given back');
  });

  it('a copy that is removed (`clean`) gives its number back, and the next new copy takes the lowest free one — which is that', () => {
    for (const name of ['app-aaaaaaaaaa', 'app-bbbbbbbbbb', 'app-cccccccccc']) allocate(name);
    const cleaned = runScript(['clean', state.workDir, 'app-bbbbbbbbbb']);
    assert.match(cleaned.stdout, /^removed=app-bbbbbbbbbb /m);
    assert.equal(allocate('app-dddddddddd').index, '1');
    assert.equal(allocate('app-eeeeeeeeee').index, '3');
  });

  it('a copy moved aside for removal (`p/.trash-*`) holds no number; a number that is not a whole number below the limit is replaced', () => {
    writeFile(state.workDir, 'p/.trash-app-old0000000-123/index', '0\n');
    writeFile(state.workDir, 'p/app-bbbbbbbbbb/index', '1\n');
    assert.equal(allocate('app-aaaaaaaaaa').index, '0', 'the trash\'s number is free');
    writeFile(state.workDir, 'p/app-cccccccccc/index', 'abc\n');
    writeFile(state.workDir, 'p/app-dddddddddd/index', `${maxCopyIndexes}\n`);
    assert.equal(allocate('app-cccccccccc').index, '2', 'a damaged number is given anew');
    assert.equal(allocate('app-dddddddddd').index, '3', 'a number out of range is given anew');
    assert.equal(readIndexFile('app-cccccccccc'), '2');
  });

  it('a new copy starts with an empty TMPDIR: what an older copy of that number left there is gone', () => {
    writeFile(state.workDir, 't/0/metro-cache/file', 'old');
    assert.equal(allocate('app-aaaaaaaaaa').index, '0');
    assert.equal(fs.existsSync(path.join(state.workDir, 't', '0')), false);
    writeFile(state.workDir, 't/0/keep', 'mine');
    assert.equal(allocate('app-aaaaaaaaaa').index, '0');
    assert.equal(fs.readFileSync(path.join(state.workDir, 't', '0', 'keep'), 'utf8'), 'mine', 'a copy that has its number keeps its TMPDIR');
  });

  it('with every number taken the copy gets none, and the job is told why — no index file is written', () => {
    for (let number = 0; number < maxCopyIndexes; number += 1) writeFile(state.workDir, `p/app-${number.toString().padStart(10, '0')}/index`, `${number}\n`);
    const result = allocate('app-zzzzzzzzzz');
    assert.equal(result.index, '');
    assert.match(result.said, new RegExp(`all ${maxCopyIndexes} numbers of project copies are taken`));
    assert.equal(readIndexFile('app-zzzzzzzzzz'), null);
  });

  it('numbers handed out at the same moment are all different — the lock decides — and the lock is gone afterwards', async () => {
    const names = Array.from({ length: 10 }, (_value, number) => `app-${number.toString().padStart(10, '0')}`);
    const runs = names.map((name) => new Promise<string>((resolve) => {
      const child = spawn('bash', ['-c', `source ${scriptPath}; work=${state.workDir}; slug=${name}; proj="$work/p/$slug"; job=; mkdir -p "$proj"; ensure_copy_index; echo "index=$copy_index"`], { env: getRunEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.on('close', () => resolve(/^index=(.*)$/m.exec(output)?.[1] ?? 'unreadable'));
    }));
    const indexes = (await Promise.all(runs)).map(Number).sort((first, second) => first - second);
    assert.deepEqual(indexes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(fs.existsSync(path.join(state.workDir, 'tmp', 'index.lock')), false);
  });

  it('a lock held by a live process is waited for only so long: the copy then gets no number, and says so — a lock whose holder is gone is broken and allocation goes on', () => {
    const holderPid = startRunnerStandIn();
    writeFile(state.workDir, 'tmp/index.lock', `${holderPid}\nsome-job\n`);
    const held = allocate('app-aaaaaaaaaa', {}, 'index_lock_wait_sec=1');
    assert.equal(held.index, '');
    assert.match(held.said, /the lock is held/);
    assert.equal(readIndexFile('app-aaaaaaaaaa'), null);
    stopRunnerStandIns();
    // The holder is dead now: a pid that is not a runner script's own reads as gone.
    assert.equal(allocate('app-aaaaaaaaaa').index, '0');
  });
});

describe('the variables a job\'s steps get', { skip: rsyncSkip }, () => {
  const seenFile = (): string => path.join(root, 'seen');
  const printVariables = (target: string): string => `printf '%s\\n' "TMPDIR=$TMPDIR" "PORT=\${REMOTE_RUN_PORT_BASE-unset}" "UDID=\${REMOTE_RUN_IOS_SIMULATOR_UDID-unset}" "OTHER=\${OTHER-unset}" > '${target}'`;
  const job = (slugName: string, jobId: string, extra: Partial<JobSpec> = {}): JobSpec => ({ slug: slugName, jobId, command: printVariables(seenFile()), ...extra });
  const readSeen = (): Record<string, string> => Object.fromEntries(fs.readFileSync(seenFile(), 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

  it('the command sees its copy\'s TMPDIR (made) and port block; the dependencies step before it sees them too; `runner-env` says the same, and the job has no Simulator device', () => {
    const installSeen = path.join(root, 'install-seen');
    const outcome = runJob(state.workDir, job('app-aaaaaaaaaa', 'box1-aaaaaa', { installCommand: printVariables(installSeen) }));
    assert.equal(outcome.exit, '0', outcome.log);
    const expected = { TMPDIR: path.join(state.workDir, 't', '0'), PORT: '20000', UDID: 'unset' };
    assert.deepEqual({ ...readSeen(), OTHER: undefined }, { ...expected, OTHER: undefined });
    assert.ok(fs.statSync(expected.TMPDIR).isDirectory(), 'the TMPDIR exists');
    const installed = Object.fromEntries(fs.readFileSync(installSeen, 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.equal(installed.TMPDIR, expected.TMPDIR);
    assert.equal(installed.PORT, '20000');
    assert.equal(fs.readFileSync(path.join(outcome.jobDir, 'runner-env'), 'utf8'), `TMPDIR=${expected.TMPDIR}\nREMOTE_RUN_PORT_BASE=20000\n`);
  });

  it('another project gets the next number, port block and TMPDIR; the first project keeps its own on its next job (nothing is rebuilt for a number that moved)', () => {
    runJob(state.workDir, job('app-aaaaaaaaaa', 'box1-aaaaaa'));
    const second = runJob(state.workDir, job('app-bbbbbbbbbb', 'box1-bbbbbb'));
    assert.equal(second.exit, '0', second.log);
    assert.deepEqual([readSeen().TMPDIR, readSeen().PORT], [path.join(state.workDir, 't', '1'), '20100']);
    runJob(state.workDir, job('app-aaaaaaaaaa', 'box1-cccccc'));
    assert.deepEqual([readSeen().TMPDIR, readSeen().PORT], [path.join(state.workDir, 't', '0'), '20000']);
  });

  it('the job\'s own -e lines: its TMPDIR takes ours back (it comes first), its REMOTE_RUN_PORT_BASE does not (ours comes last); other variables are its own', () => {
    const outcome = runJob(state.workDir, job('app-aaaaaaaaaa', 'box1-aaaaaa', { env: ['TMPDIR=/job/own/tmp', 'REMOTE_RUN_PORT_BASE=7', 'OTHER=mine'] }));
    assert.equal(outcome.exit, '0', outcome.log);
    assert.deepEqual(readSeen(), { TMPDIR: '/job/own/tmp', PORT: '20000', UDID: 'unset', OTHER: 'mine' });
  });

  it('a job whose copy could get no number runs all the same — with the TMPDIR and ports of the machine, and a line in its log that says why', () => {
    for (let number = 0; number < maxCopyIndexes; number += 1) writeFile(state.workDir, `p/other-${number.toString().padStart(10, '0')}/index`, `${number}\n`);
    const outcome = runJob(state.workDir, job('app-aaaaaaaaaa', 'box1-aaaaaa'), { TMPDIR: '/machine/tmp' });
    assert.equal(outcome.exit, '0', outcome.log);
    assert.deepEqual(readSeen(), { TMPDIR: '/machine/tmp', PORT: 'unset', UDID: 'unset', OTHER: 'unset' });
    assert.match(outcome.log, /remote-run: no port block and no TMPDIR of its own for this job: all 100 numbers/);
    assert.equal(fs.readFileSync(path.join(outcome.jobDir, 'runner-env'), 'utf8'), '');
  });

  it('a TMPDIR that cannot be made (a full disk, a file where the folder goes) costs the job only that: it keeps its port block - two jobs must not fall back to the same default ports because of a disk - and its log says what is missing', () => {
    // `t` is a file: `mkdir -p t/0` fails the way it does on a disk with no room.
    writeFile(state.workDir, 't', 'not a folder');
    const outcome = runJob(state.workDir, job('app-aaaaaaaaaa', 'box1-aaaaaa'), { TMPDIR: '/machine/tmp' });
    assert.equal(outcome.exit, '0', outcome.log);
    assert.deepEqual(readSeen(), { TMPDIR: '/machine/tmp', PORT: '20000', UDID: 'unset', OTHER: 'unset' });
    assert.match(outcome.log, /remote-run: no TMPDIR of its own for this job: .*\/t\/0 cannot be made/);
    assert.equal(fs.readFileSync(path.join(outcome.jobDir, 'runner-env'), 'utf8'), 'REMOTE_RUN_PORT_BASE=20000\n');
  });

  it('`exec` gets none of them: it takes no lock and may run beside a job of its own copy', async () => {
    runJob(state.workDir, job('app-aaaaaaaaaa', 'box1-aaaaaa'));
    const execSeen = path.join(root, 'exec-seen');
    const child = spawn('bash', [scriptPath, 'exec', state.workDir, 'app-aaaaaaaaaa', '', '60', printVariables(execSeen)], { env: getRunEnvironment({ TMPDIR: '/machine/tmp' }), stdio: ['pipe', 'ignore', 'ignore'] });
    // The lease is the stream on stdin: it stays open until the command is done.
    await new Promise<void>((resolve) => { child.on('close', () => resolve()); });
    const seen = Object.fromEntries(fs.readFileSync(execSeen, 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.deepEqual(seen, { TMPDIR: '/machine/tmp', PORT: 'unset', UDID: 'unset', OTHER: 'unset' });
  });
});

describe('a copy that goes', { skip: rsyncSkip }, () => {
  const command = 'true';
  const udid = '00000000-0000-0000-0000-000000000042';

  function runOnce(slugName: string, jobId: string): void {
    const outcome = runJob(state.workDir, { slug: slugName, jobId, command });
    assert.equal(outcome.exit, '0', outcome.log);
  }

  it('`clean` takes its TMPDIR with it, puts its Simulator device on the retired list (once, however often), and the number is free at once', () => {
    runOnce('app-aaaaaaaaaa', 'box1-aaaaaa');
    runOnce('app-bbbbbbbbbb', 'box1-bbbbbb');
    writeFile(state.workDir, 'p/app-bbbbbbbbbb/ios-simulator', `${udid}\n`);
    writeFile(state.workDir, 't/1/cache/file', 'x');
    const jobFinished = path.join(state.workDir, 'p', 'app-bbbbbbbbbb', 'jobs', 'box1-bbbbbb', 'exit');
    fs.utimesSync(jobFinished, new Date(0), new Date(0));
    const cleaned = runScript(['clean', state.workDir, 'app-bbbbbbbbbb']);
    assert.match(cleaned.stdout, /^removed=app-bbbbbbbbbb /m, cleaned.stdout);
    assert.equal(fs.existsSync(path.join(state.workDir, 't', '1')), false, 'its TMPDIR is gone');
    assert.equal(fs.existsSync(path.join(state.workDir, 't', '0')), true, 'another copy\'s TMPDIR is not touched');
    assert.equal(fs.readFileSync(path.join(state.workDir, 'ios-devices-retired'), 'utf8'), `${udid}\n`);
    assert.equal(readIndexFile('app-bbbbbbbbbb'), null);
    // The same device named twice stays one line.
    runOnce('app-cccccccccc', 'box1-cccccc');
    writeFile(state.workDir, 'p/app-cccccccccc/ios-simulator', `${udid}\n`);
    fs.utimesSync(path.join(state.workDir, 'p', 'app-cccccccccc', 'jobs', 'box1-cccccc', 'exit'), new Date(0), new Date(0));
    runScript(['clean', state.workDir, 'app-cccccccccc']);
    assert.equal(fs.readFileSync(path.join(state.workDir, 'ios-devices-retired'), 'utf8'), `${udid}\n`);
  });

  it('the idle-copy prune does the same for a copy nobody used for days', () => {
    runOnce('app-aaaaaaaaaa', 'box1-aaaaaa');
    writeFile(state.workDir, 'p/app-aaaaaaaaaa/ios-simulator', `${udid}\n`);
    writeFile(state.workDir, 't/0/cache/file', 'x');
    const longAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    for (const file of ['used', 'jobs/box1-aaaaaa/exit']) fs.utimesSync(path.join(state.workDir, 'p', 'app-aaaaaaaaaa', file), longAgo, longAgo);
    const pruned = runScript(['prune', state.workDir]);
    assert.equal(pruned.status, 0, pruned.stderr);
    assert.equal(fs.existsSync(path.join(state.workDir, 'p', 'app-aaaaaaaaaa')), false);
    assert.equal(fs.existsSync(path.join(state.workDir, 't', '0')), false);
    assert.equal(fs.readFileSync(path.join(state.workDir, 'ios-devices-retired'), 'utf8'), `${udid}\n`);
  });

  it('a copy that is in use is refused, and keeps its number, its TMPDIR and its device: nothing is retired', async () => {
    const holding: JobSpec = { slug: 'app-aaaaaaaaaa', jobId: 'box1-aaaaaa', command: `touch '${root}/started'; sleep 60` };
    const child = startJob(state.workDir, holding);
    try {
      await waitUntil('the job to run its command', () => fs.existsSync(path.join(root, 'started')));
      writeFile(state.workDir, 'p/app-aaaaaaaaaa/ios-simulator', `${udid}\n`);
      const cleaned = runScript(['clean', state.workDir, 'app-aaaaaaaaaa']);
      assert.match(cleaned.stdout, /^busy=app-aaaaaaaaaa kind=running job=box1-aaaaaa$/m, cleaned.stdout);
      assert.equal(fs.existsSync(path.join(state.workDir, 't', '0')), true);
      assert.equal(readIndexFile('app-aaaaaaaaaa'), '0');
      assert.equal(fs.existsSync(path.join(state.workDir, 'ios-devices-retired')), false);
    } finally {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    }
  });

  it('a removal that was cut off (a folder under p/.trash-*) is finished by the next `clean`: its device is retired, and its TMPDIR is NOT touched — its number may be another copy\'s by now', () => {
    runOnce('app-aaaaaaaaaa', 'box1-aaaaaa');
    writeFile(state.workDir, 'p/.trash-app-old0000000-99999999/index', '0\n');
    writeFile(state.workDir, 'p/.trash-app-old0000000-99999999/ios-simulator', `${udid}\n`);
    const cleaned = runScript(['clean', state.workDir, 'app-old0000000']);
    assert.match(cleaned.stdout, /^removed=app-old0000000 /m, cleaned.stdout);
    assert.equal(fs.existsSync(path.join(state.workDir, 'p', '.trash-app-old0000000-99999999')), false);
    assert.equal(fs.readFileSync(path.join(state.workDir, 'ios-devices-retired'), 'utf8'), `${udid}\n`);
    assert.equal(fs.existsSync(path.join(state.workDir, 't', '0')), true, 'copy 0\'s TMPDIR belongs to the live copy that holds 0');
  });

  it('a copy that holds no device or a damaged record retires nothing', () => {
    runOnce('app-aaaaaaaaaa', 'box1-aaaaaa');
    runOnce('app-bbbbbbbbbb', 'box1-bbbbbb');
    writeFile(state.workDir, 'p/app-bbbbbbbbbb/ios-simulator', 'not a device id; rm -rf /\n');
    for (const name of ['app-aaaaaaaaaa', 'app-bbbbbbbbbb']) fs.utimesSync(path.join(state.workDir, 'p', name, 'jobs', name === 'app-aaaaaaaaaa' ? 'box1-aaaaaa' : 'box1-bbbbbb', 'exit'), new Date(0), new Date(0));
    runScript(['clean', state.workDir, 'app-aaaaaaaaaa']);
    runScript(['clean', state.workDir, 'app-bbbbbbbbbb']);
    assert.equal(fs.existsSync(path.join(state.workDir, 'ios-devices-retired')), false);
  });
});

/**
 * A TMPDIR is where Metro's and Jest's caches land: hundreds of thousands of files, several GB, minutes to remove. A stand-in `rm` that takes FAKE_RM_DELAY seconds over a folder that sits directly in `<work>/t/`
 * (and leaves a marker when it starts) stands for that. Everything else it removes at once.
 */
function installSlowRm(): { binDir: string; startedMarker: string } {
  const binDir = path.join(root, 'slow-rm-bin');
  const startedMarker = path.join(root, 'slow-rm-started');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'rm'),
    `#!/bin/bash\ntarget=\${@: -1}\ncase "$(dirname "$target")" in */t) if [ -n "\${FAKE_RM_DELAY:-}" ]; then : > '${startedMarker}'; sleep "$FAKE_RM_DELAY"; fi ;; esac\nexec /bin/rm "$@"\n`,
    { mode: 0o755 },
  );
  return { binDir, startedMarker };
}

describe('a TMPDIR that takes long to remove does not hold the numbers back', { skip: rsyncSkip }, () => {
  const slowDelaySec = 8;

  it('a copy that goes: its number is free and handed out again while its TMPDIR is still being removed - the new copy gets it at once, and what the remover is still removing is NOT the new copy\'s TMPDIR', async () => {
    const runOnce = (name: string, jobId: string): void => {
      const outcome = runJob(state.workDir, { slug: name, jobId, command: 'true' });
      assert.equal(outcome.exit, '0', outcome.log);
    };
    runOnce('app-aaaaaaaaaa', 'box1-aaaaaa');
    writeFile(state.workDir, 't/0/cache/big', 'x');
    fs.utimesSync(path.join(state.workDir, 'p', 'app-aaaaaaaaaa', 'jobs', 'box1-aaaaaa', 'exit'), new Date(0), new Date(0));
    const { binDir, startedMarker } = installSlowRm();
    const cleaning = new Promise<string>((resolve) => {
      const child = spawn('bash', [scriptPath, 'clean', state.workDir, 'app-aaaaaaaaaa'], { env: getRunEnvironment({ PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_RM_DELAY: `${slowDelaySec}` }), stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.on('close', () => resolve(output));
    });
    await waitUntil('the removal of the TMPDIR to start', () => fs.existsSync(startedMarker));
    const startedAt = Date.now();
    // The number was freed with the copy: a new copy is given it now, with a wait of 3 s at most for the lock - a lock held for the whole removal would leave it with none.
    const next = allocate('app-cccccccccc', {}, 'index_lock_wait_sec=3');
    assert.equal(next.index, '0', next.said);
    assert.ok(Date.now() - startedAt < slowDelaySec * 1000 - 2000, `${Date.now() - startedAt} ms: it did not wait for the removal`);
    writeFile(state.workDir, 't/0/started-by-the-new-copy', 'mine');
    assert.match(await cleaning, /^removed=app-aaaaaaaaaa /m);
    assert.equal(fs.readFileSync(path.join(state.workDir, 't', '0', 'started-by-the-new-copy'), 'utf8'), 'mine', 'the remover took the old TMPDIR only');
    assert.deepEqual(fs.readdirSync(path.join(state.workDir, 't')).filter((name) => name.startsWith('.gone-')), [], 'what was set aside is removed');
  });

  it('a number handed out for a TMPDIR an earlier copy left behind wipes it AFTER the lock is given back: the next allocation is not kept waiting', async () => {
    writeFile(state.workDir, 't/0/cache/leftover', 'x');
    const { binDir, startedMarker } = installSlowRm();
    const first = new Promise<string>((resolve) => {
      const child = spawn('bash', ['-c', `source ${scriptPath}; work=${state.workDir}; slug=app-aaaaaaaaaa; proj="$work/p/$slug"; job=; mkdir -p "$proj"; ensure_copy_index; echo "index=$copy_index"`], {
        env: getRunEnvironment({ PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_RM_DELAY: `${slowDelaySec}` }),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.on('close', () => resolve(output));
    });
    await waitUntil('the wipe of the leftover to start', () => fs.existsSync(startedMarker));
    const startedAt = Date.now();
    const second = allocate('app-bbbbbbbbbb', {}, 'index_lock_wait_sec=3');
    assert.equal(second.index, '1', second.said);
    assert.ok(Date.now() - startedAt < slowDelaySec * 1000 - 2000, `${Date.now() - startedAt} ms`);
    assert.match(await first, /^index=0$/m);
    assert.equal(fs.existsSync(path.join(state.workDir, 't', '0', 'cache')), false, 'the leftover is gone from the new copy\'s TMPDIR');
  });

  it('a removal that was cut off leaves its set-aside folder (`t/.gone-<pid>-<k>-…`): the prune finishes it once that process is gone, and leaves one whose process lives', () => {
    const livePid = startRunnerStandIn();
    writeFile(state.workDir, 't/.gone-99999999-3-1/cache/file', 'x');
    writeFile(state.workDir, `t/.gone-${livePid}-4-2/cache/file`, 'y');
    writeFile(state.workDir, 't/7/mine', 'a live copy\'s TMPDIR');
    const pruned = runScript(['prune', state.workDir]);
    assert.equal(pruned.status, 0, pruned.stderr);
    assert.equal(fs.existsSync(path.join(state.workDir, 't', '.gone-99999999-3-1')), false, 'its remover is gone: finished');
    assert.equal(fs.existsSync(path.join(state.workDir, 't', `.gone-${livePid}-4-2`)), true, 'its remover lives: it is at it');
    assert.equal(fs.existsSync(path.join(state.workDir, 't', '7', 'mine')), true, 'a TMPDIR in use is not touched');
  });
});

describe('two jobs of different projects that start at the same moment', { skip: rsyncSkip }, () => {
  it('both run, and each gets a number of its own', async () => {
    const first: JobSpec = { slug: 'app-aaaaaaaaaa', jobId: 'box1-aaaaaa', command: 'true' };
    const second: JobSpec = { slug: 'app-bbbbbbbbbb', jobId: 'box1-bbbbbb', command: 'true' };
    const children = [startJob(state.workDir, first), startJob(state.workDir, second)];
    const exits = await Promise.all([waitForJobExit(state.workDir, first), waitForJobExit(state.workDir, second)]);
    assert.deepEqual(exits, ['0', '0']);
    assert.deepEqual([readIndexFile('app-aaaaaaaaaa'), readIndexFile('app-bbbbbbbbbb')].sort(), ['0', '1']);
    for (const child of children) child.kill('SIGKILL');
  });
});
