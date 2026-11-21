/**
 * @description `runner-scripts/runner.sh` — the disk upkeep of a runner, the sizes and the concurrent-prune part of `remoteRunRunnerScriptDisk.test.ts` (they share `remoteRunRunnerScriptDiskKit.ts`; split because a file runs under one time limit
 * and one ran 70+ s alone on a loaded box): the sizes of the project copies (`measure-copies`) and what `probe` says of them, and two prunes at once. Run against the real script and a real shell, with the fake disk of the kit.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { diskTooLowRunnerExitCode } from '../remoteRun/pruneReport';
import { parseProbeOutput } from '../remoteRun/probe';
import { jobId, scriptPath, slug, startRunnerStandIn, startStrangerProcess, writeFile } from './remoteRunRunnerScriptKit';
import { kibPerGib, hourMs, workRoot, workDir, getEnv, runScript, setAge, makeCopy, writeJob, getDeadPid, runShell, listCopies, parseRemovals, useDiskHarness } from './remoteRunRunnerScriptDiskKit';

useDiskHarness();

describe('sizes of the project copies (`measure-copies`) and what `probe` says of them', () => {
  const sizeFile = (copySlug: string): string => path.join(workDir, 'p', copySlug, 'size-kb');

  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${what} did not happen`);
  }

  it('writes the size of a copy whose figure is missing or was written before the copy was last used — and leaves alone one nobody touched since, however long ago it was written', () => {
    makeCopy('missing-vvvvvvvvvv', 7, hourMs);
    makeCopy('used-since-wwwwwwwwww', 3, hourMs);
    writeFile(path.join(workDir, 'p', 'used-since-wwwwwwwwww'), 'size-kb', '1');
    setAge(sizeFile('used-since-wwwwwwwwww'), 2 * hourMs);
    makeCopy('untouched-xxxxxxxxxx', 4, 30 * hourMs);
    writeFile(path.join(workDir, 'p', 'untouched-xxxxxxxxxx'), 'size-kb', '5');
    setAge(sizeFile('untouched-xxxxxxxxxx'), 29 * hourMs);
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    assert.equal(fs.readFileSync(sizeFile('missing-vvvvvvvvvv'), 'utf8').trim(), `${7 * kibPerGib}`);
    assert.equal(fs.readFileSync(sizeFile('used-since-wwwwwwwwww'), 'utf8').trim(), `${3 * kibPerGib}`, 'used after its figure: measured again');
    assert.equal(fs.readFileSync(sizeFile('untouched-xxxxxxxxxx'), 'utf8').trim(), '5', 'a figure a day old is still right for a copy nobody used since: no `du` over millions of files for it');
  });

  it('leaves a copy that is IN USE alone once it has a figure — it would be wrong as soon as the build writes, and the walk would compete with the build — walks one with NO figure once anyway, and measures the first again when nothing uses it', () => {
    const busyDir = makeCopy('busy-ffffffffff', 5, hourMs);
    writeFile(busyDir, 'size-kb', '1');
    setAge(sizeFile('busy-ffffffffff'), 2 * hourMs);
    const execPid = startRunnerStandIn();
    writeFile(busyDir, `exec.${execPid}`, `${execPid}\n`);
    const newDir = makeCopy('new-jjjjjjjjjj', 9, hourMs);
    const newPid = startRunnerStandIn();
    writeFile(newDir, `exec.${newPid}`, `${newPid}\n`);
    makeCopy('idle-gggggggggg', 3, hourMs);
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    assert.equal(fs.readFileSync(sizeFile('busy-ffffffffff'), 'utf8').trim(), '1', 'a copy an `exec` runs in keeps the figure it has');
    assert.equal(fs.readFileSync(sizeFile('new-jjjjjjjjjj'), 'utf8').trim(), `${9 * kibPerGib}`, 'one in use that never had a figure is walked once — a refusal on a short disk names the copies it can');
    assert.equal(fs.readFileSync(sizeFile('idle-gggggggggg'), 'utf8').trim(), `${3 * kibPerGib}`, 'the idle one is measured');
    fs.rmSync(path.join(busyDir, `exec.${execPid}`));
    assert.equal(runScript(['measure-copies', workDir]).status, 0);
    assert.equal(fs.readFileSync(sizeFile('busy-ffffffffff'), 'utf8').trim(), `${5 * kibPerGib}`, 'after the exec: measured again');
  });

  /** The detached `measure-copies` that a call started has ended (its pid is gone). */
  async function waitForDetachedMeasuringToEnd(): Promise<void> {
    const pidFile = path.join(workDir, 'tmp', 'measure-copies.pid');
    const detachedPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await waitFor(() => {
      try {
        process.kill(detachedPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'the detached measuring to end');
  }

  it('a submit that goes on (the disk is fine) starts no measuring of the other copies; one that is refused for a short disk does — the refusal names the biggest copies for the next submit', async () => {
    makeCopy('neighbour-hhhhhhhhhh', 10, 5 * hourMs);
    const prepared = runScript(['prepare', workDir, slug, jobId, 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '10' });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(fs.existsSync(path.join(workDir, 'tmp', 'measure-copies.pid')), false, 'no walk over the neighbour\'s tree for a submit that is not refused');
    const busyDir = makeCopy('busy-iiiiiiiiii', 45, 2 * hourMs);
    writeJob(busyDir, 'box1-busy03', { 'task-id': '5\n' });
    const refused = runScript(['prepare', workDir, slug, 'box1-second', 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '60' });
    assert.equal(refused.status, diskTooLowRunnerExitCode, refused.stderr);
    assert.equal(fs.existsSync(path.join(workDir, 'tmp', 'measure-copies.pid')), true, 'the refusal started the measuring');
    assert.match(refused.stderr, /their sizes are still being measured/, 'the copies in use have no figure yet');
    await waitForDetachedMeasuringToEnd();
    assert.equal(fs.readFileSync(sizeFile('busy-iiiiiiiiii'), 'utf8').trim(), `${45 * kibPerGib}`, 'the measuring walked the copy in use that had no figure — once');
    const refusedAgain = runScript(['prepare', workDir, slug, 'box1-third0', 'default=1'], { REMOTE_RUN_MIN_FREE_GB: '60' });
    assert.equal(refusedAgain.status, diskTooLowRunnerExitCode, refusedAgain.stderr);
    assert.match(refusedAgain.stderr, /biggest project copies: busy-iiiiiiiiii 45 GB/, 'and the next refusal names it');
    await waitForDetachedMeasuringToEnd();
  });

  it('probe counts the copies and sums their written figures at once, and starts the measuring of the missing ones detached', async () => {
    makeCopy('known-yyyyyyyyyy', 7, hourMs);
    writeFile(path.join(workDir, 'p', 'known-yyyyyyyyyy'), 'size-kb', `${7 * kibPerGib}`);
    makeCopy('unknown-zzzzzzzzzz', 3, hourMs);
    const result = runScript(['probe', workDir, 'prune']);
    assert.equal(result.status, 0, result.stderr);
    const probe = parseProbeOutput(result.stdout);
    assert.deepEqual(probe.copies, { count: 2, sizeMb: 7 * 1024, unmeasuredCount: 1, clonedCount: 0 });
    assert.equal(probe.diskMinFreeMb, 15 * 1024, 'the default target of a 100 GB disk: 15 %');
    await waitFor(() => fs.existsSync(sizeFile('unknown-zzzzzzzzzz')), 'the detached measuring');
    assert.equal(fs.readFileSync(sizeFile('unknown-zzzzzzzzzz'), 'utf8').trim(), `${3 * kibPerGib}`);
  });

  it('the probe a run or an `exec` makes first (no `prune`) counts the copies the same, but starts NO measuring: the copy about to be built is not walked as its build begins', () => {
    makeCopy('known-kkkkkkkkkk', 7, hourMs);
    writeFile(path.join(workDir, 'p', 'known-kkkkkkkkkk'), 'size-kb', `${7 * kibPerGib}`);
    setAge(sizeFile('known-kkkkkkkkkk'), 2 * hourMs);
    makeCopy('unknown-llllllllll', 3, hourMs);
    const result = runScript(['probe', workDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseProbeOutput(result.stdout).copies, { count: 2, sizeMb: 7 * 1024, unmeasuredCount: 2, clonedCount: 0 }, 'both are unmeasured: one has no figure, the other was used after its figure');
    assert.equal(fs.existsSync(path.join(workDir, 'tmp', 'measure-copies.pid')), false, 'and nothing was started');
    assert.equal(fs.existsSync(sizeFile('unknown-llllllllll')), false);
  });

  it('probe of a VIEW (`probe <work> prune`) on a disk short of free space starts the prune detached instead of making the probe wait for it', async () => {
    makeCopy('oldest-aaaaaaaaaa', 45, 5 * hourMs);
    makeCopy('newest-cccccccccc', 45, 1 * hourMs);
    const result = runScript(['probe', workDir, 'prune']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseProbeOutput(result.stdout).diskFreeMb, 10 * 1024, 'the probe reports the disk as it found it');
    await waitFor(() => listCopies().length === 1, 'the detached prune');
    assert.deepEqual(listCopies(), ['newest-cccccccccc']);
  });

  it('probe on a disk at its target removes nothing', () => {
    makeCopy('only-aaaaaaaaaa', 10, 5 * hourMs);
    assert.equal(runScript(['probe', workDir]).status, 0);
    assert.deepEqual(listCopies(), ['only-aaaaaaaaaa']);
  });
});

describe('two prunes at once', () => {
  function makeThreeCopies(): void {
    makeCopy('oldest-aaaaaaaaaa', 30, 5 * hourMs);
    makeCopy('middle-bbbbbbbbbb', 30, 3 * hourMs);
    makeCopy('newest-cccccccccc', 30, 1 * hourMs);
  }

  const lockFile = (): string => path.join(workDir, 'tmp', 'prune.lock');

  /** The lock of the copy-removal step as another prune holds it: its pid inside, made `ageMs` ago. */
  function putPruneLock(holderPid: number | string, ageMs = 60_000): string {
    writeFile(workDir, 'tmp/prune.lock', typeof holderPid === 'number' ? `${holderPid}\n` : holderPid);
    setAge(lockFile(), ageMs);
    return lockFile();
  }

  it('a trash folder whose remover still lives is left to it; one whose remover is gone is finished', () => {
    const livePid = startRunnerStandIn();
    const deadPid = getDeadPid();
    writeFile(path.join(workDir, 'p', `.trash-being-removed-${livePid}`), 'tree/file.txt');
    writeFile(path.join(workDir, 'p', `.trash-cut-off-${deadPid}`), 'tree/file.txt');
    assert.equal(runShell(`remove_leftover_trash ${workDir}`).status, 0);
    assert.ok(fs.existsSync(path.join(workDir, 'p', `.trash-being-removed-${livePid}`)));
    assert.equal(fs.existsSync(path.join(workDir, 'p', `.trash-cut-off-${deadPid}`)), false);
  });

  it('the probe\'s detached prune (`prune`) leaves the copy-removal step to a prune that is at it, and says nothing — the lock stays the other\'s', () => {
    makeThreeCopies();
    const livePid = startRunnerStandIn();
    putPruneLock(livePid);
    const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(listCopies().length, 3);
    assert.equal(fs.readFileSync(lockFile(), 'utf8').trim(), `${livePid}`);
  });

  it('in skip mode it leaves at once even though its disk is short — it never waits (a probe must not hang)', () => {
    makeThreeCopies();
    putPruneLock(startRunnerStandIn());
    const outcome = runShell(`prune_wait_sec=3; prune_poll_sec=0.2; started=$SECONDS; prune_work ${workDir} "" skip; echo waited=$((SECONDS - started))`, { REMOTE_RUN_MIN_FREE_GB: '70' });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /waited=[0-2]$/, 'not the 3 s of the wait it must not make');
    assert.equal(listCopies().length, 3, 'and it removed nothing: after a wait it would have gone on without the lock');
  });

  describe('a lock that nobody holds any more is taken over, and the prune goes on', () => {
    const scenarios: Array<[string, () => void]> = [
      ['its holder is gone', () => { putPruneLock(getDeadPid()); }],
      ['its pid went to a stranger (a daemon after a reboot)', () => { putPruneLock(startStrangerProcess()); }],
      ['it is over two hours old (a pid can be given to anything)', () => { putPruneLock(startRunnerStandIn(), 3 * hourMs); }],
      ['it is empty and over a minute old (its creator died between the create and the write)', () => { putPruneLock('', 3 * 60_000); }],
      ['it holds no pid at all', () => { putPruneLock('not a pid\n', 60_000); }],
    ];
    for (const [name, setUp] of scenarios) {
      it(name, () => {
        makeThreeCopies();
        setUp();
        const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' });
        assert.deepEqual(parseRemovals(result.stdout), ['oldest-aaaaaaaaaa', 'middle-bbbbbbbbbb']);
        assert.equal(fs.existsSync(lockFile()), false, 'and its own lock is gone when it ends');
        assert.deepEqual(fs.readdirSync(path.join(workDir, 'tmp')).filter((entry) => entry.startsWith('prune.lock')), [], 'no right to break it is left behind');
      });
    }

    it('a right to break the lock that its winner died holding does not block anybody: the next generation takes it (the project lock\'s rule, not a second copy of it)', () => {
      const deadHolder = getDeadPid();
      putPruneLock(deadHolder);
      writeFile(workDir, `tmp/prune.lock.breaking.${deadHolder}.none.0`, `${getDeadPid()}\n\n`);
      const outcome = runShell(`acquire_prune_lock ${workDir} && echo won || echo lost`);
      assert.equal(outcome.stdout, 'won');
    });

    it('an EMPTY lock that is young is a creator about to write: it is held', () => {
      makeThreeCopies();
      putPruneLock('', 1000);
      const result = runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '70' });
      assert.equal(result.stdout, '');
      assert.equal(listCopies().length, 3);
    });

    it('a breaker that is slow between checking the lock and removing it cannot take a fresh lock away: the right to break is exclusive, so a second process that finds the same stale lock meanwhile loses', async () => {
      putPruneLock(getDeadPid());
      // B stalls for a second just before it removes the lock (its `rm`); A arrives 0.3 s later at the same stale lock. If A could break it too, A would remove it, take a fresh one, and B's late `rm` would delete A's
      // fresh lock — two holders.
      const slowBreaker = `rm() { case "$*" in *prune.lock) sleep 1 ;; esac; command rm "$@"; }; acquire_prune_lock ${workDir} && { echo B-won; sleep 3; } || echo B-lost`;
      const quickBreaker = `sleep 0.3; acquire_prune_lock ${workDir} && { echo A-won; sleep 3; } || echo A-lost`;
      const outputs = await Promise.all([slowBreaker, quickBreaker].map((body) => new Promise<string>((resolve) => {
        const child = spawn('bash', ['-c', `source ${scriptPath}; ${body}`], { env: getEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('close', () => resolve(output.trim()));
      })));
      assert.deepEqual(outputs, ['B-won', 'A-lost']);
    });

    it('a stale verdict made on an old read does not break a fresh lock: a process that was slow after reading the stale holder finds somebody else\'s lock when it goes on, and leaves it alone', async () => {
      putPruneLock(getDeadPid());
      const flag = path.join(workRoot, 'stalled-once');
      // B reads the stale holder and stalls for a second, once; A comes 0.3 s later, breaks the lock and takes a fresh one. When B goes on, the lock is A's and must stay.
      const slowReader = `eval "orig_$(declare -f read_lock_holder)"; read_lock_holder() { orig_read_lock_holder "$@"; case "$1" in *prune.lock) [ -e ${flag} ] || { : > ${flag}; sleep 1; } ;; esac; }; acquire_prune_lock ${workDir} && { echo B-won; sleep 3; } || echo B-lost`;
      const quickBreaker = `sleep 0.3; acquire_prune_lock ${workDir} && { echo A-won; sleep 3; } || echo A-lost`;
      const outputs = await Promise.all([slowReader, quickBreaker].map((body) => new Promise<string>((resolve) => {
        const child = spawn('bash', ['-c', `source ${scriptPath}; ${body}`], { env: getEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('close', () => resolve(output.trim()));
      })));
      assert.deepEqual(outputs, ['B-lost', 'A-won']);
    });

    it('of several processes that find the same stale lock exactly one gets it (the right to break it is exclusive); the rest see it held', () => {
      putPruneLock(getDeadPid());
      const contenders = 8;
      // The winner keeps the lock for two seconds, like a prune at work: a lock whose holder had already exited would be stale again for the next contender.
      const body = `acquire_prune_lock ${workDir} && { echo won; sleep 2; } || echo lost`;
      const results = Array.from({ length: contenders }, () => spawn('bash', ['-c', `source ${scriptPath}; ${body}`], { env: getEnv(), stdio: ['ignore', 'pipe', 'ignore'] }));
      return Promise.all(results.map((child) => new Promise<string>((resolve) => {
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('close', () => resolve(output.trim()));
      }))).then((outputs) => {
        assert.equal(outputs.filter((output) => output === 'won').length, 1, outputs.join(','));
      });
    });
  });

  it('a submit\'s prune WAITS for the other one and then decides by the disk as the other left it (here the other freed enough: it removes nothing)', () => {
    makeThreeCopies();
    const otherLock = putPruneLock(startRunnerStandIn());
    // The other prune ends its work after a second: it removed the oldest copy and its lock goes.
    const body = `prune_poll_sec=0.1; ( sleep 1; command rm -rf "${path.join(workDir, 'p', 'oldest-aaaaaaaaaa')}" "${otherLock}" ) & started=$SECONDS; prune_work ${workDir} ""; echo waited=$((SECONDS - started))`;
    const outcome = runShell(body, { REMOTE_RUN_MIN_FREE_GB: '40' });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listCopies(), ['middle-bbbbbbbbbb', 'newest-cccccccccc'], 'it removed nothing of its own: 40 GB were free once the other was done');
    assert.match(outcome.stdout, /waited=[1-9]/);
  });

  it('the wait is bounded: a prune that never ends is waited for prune_wait_sec, then the submit goes on without the lock — and leaves the other\'s lock alone', () => {
    makeThreeCopies();
    const livePid = startRunnerStandIn();
    putPruneLock(livePid);
    const outcome = runShell(`prune_wait_sec=1; prune_poll_sec=0.2; started=$SECONDS; prune_work ${workDir} ""; echo waited=$((SECONDS - started))`, { REMOTE_RUN_MIN_FREE_GB: '40' });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(listCopies(), ['middle-bbbbbbbbbb', 'newest-cccccccccc']);
    assert.match(outcome.stdout, /waited=[1-4]$/);
    assert.equal(fs.readFileSync(lockFile(), 'utf8').trim(), `${livePid}`, 'a prune that never had the lock does not give it back');
  });

  it('its own lock is gone when it ends', () => {
    makeThreeCopies();
    assert.equal(runScript(['prune', workDir], { REMOTE_RUN_MIN_FREE_GB: '40' }).status, 0);
    assert.equal(fs.existsSync(lockFile()), false);
  });

  it('two real prunes started at the same moment remove ONE copy between them, not one each (the second finds the first at it and leaves, or waits and finds the disk fine)', async () => {
    makeThreeCopies();
    const env = getEnv({ REMOTE_RUN_MIN_FREE_GB: '40', FAKE_RM_DELAY: '1' });
    const outputs = await Promise.all([0, 1].map(() => new Promise<string>((resolve) => {
      const child = spawn('bash', [scriptPath, 'prune', workDir], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.on('close', () => resolve(output));
    })));
    assert.equal(outputs.flatMap(parseRemovals).length, 1, outputs.join(' | '));
    assert.deepEqual(listCopies(), ['middle-bbbbbbbbbb', 'newest-cccccccccc']);
  });
});
