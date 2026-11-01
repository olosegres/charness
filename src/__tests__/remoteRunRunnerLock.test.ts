/**
 * @description The project lock of `remoteRun/runner.sh` — what keeps two jobs of one project off one tree: the lock is made with the shell's
 * own exclusive create (never `mkdir`, which the uutils coreutils do not make exclusive), a stale lock is broken by ONE waiter holding the
 * right to break that very dead holder's lock, and a job gives back only a lock that is still its own. Raced with real concurrent waiters
 * (a lock whose holder is dead, with and without a breaker that died too) and proven one rule at a time. In a file of its own so the
 * race tests, which take most of the time, stay inside the two minutes `yarn test` allows a unit file.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scriptPath, slug, writeFile } from './remoteRunRunnerScriptKit';

let workRoot = '';
let workDir = '';

beforeEach(() => {
  workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-lock-')));
  workDir = path.join(workRoot, 'work');
  fs.mkdirSync(workDir);
});
afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe('the project lock', () => {
  const contenders = 5;
  const rounds = 15;
  /** The uutils `mkdir` let several attempts win in about one race of five (measured: 265 of 1200), so this many rounds cannot miss a lock that is not exclusive. */
  const exclusiveCreateRounds = 100;
  const criticalHoldSeconds = 0.05;
  /** Waiters retry this often (the script's own pause is a second: rounds of five waiters would run for minutes, over the two a unit file may take). */
  const lockPollSeconds = 0.05;
  /** Exclusive create for the test's own overlap detector: not `mkdir` (see the guard below), or the detector would miss overlaps. */
  const claimCritical = '( set -C; echo claimed > "$proj/critical" ) 2> /dev/null';

  function runBash(body: string, timeoutMs = 60_000): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync('bash', ['-c', `source ${scriptPath}; ${body}`], { encoding: 'utf8', env: { ...process.env, PUEUE_BIN: '/nonexistent/pueue' }, timeout: timeoutMs });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * `rounds` times: a lock whose holder is dead (a job that was force-killed), and `contenders` waiting jobs of the project that all
   * take it at once and spend a moment inside the critical section — which only one may be in. Returns how many were in it together
   * (the sections of a project must never overlap: two jobs would run on one tree) and how many contenders finished.
   */
  function raceForAStaleLock(options: { withDeadBreaker?: boolean } = {}): { overlaps: number; finished: number } {
    const project = path.join(workDir, 'p', slug);
    fs.mkdirSync(project, { recursive: true });
    const deadPid = spawnSync('true').pid;
    // A breaker that died after it won the right to break this lock: its file is there, held by a process that is gone.
    const plantDeadBreaker = options.withDeadBreaker === true ? `printf '%s\\n%s\\n' ${deadPid} box1-deadbk > "$lock.breaking.${deadPid}.box1-dead$round.0"` : ':';
    // The trap ends the waiters with the driver: when the lock is broken they spin for ever, and a driver that timed out must not leave them behind.
    const driver = `
      work=${workDir}; killed=0; lock_poll_sec=${lockPollSeconds}
      trap 'kill $(jobs -p) 2> /dev/null' EXIT TERM
      set_paths ${workDir} ${slug} box1-race00
      for round in $(seq 1 ${rounds}); do
        rm -f "$lock" "$lock".breaking.* "$proj/critical"
        printf '%s\\n%s\\n' ${deadPid} box1-dead$round > "$lock"
        ${plantDeadBreaker}
        for contender in $(seq 1 ${contenders}); do
          (
            acquire_lock || exit 3
            ${claimCritical} || echo overlap >> "$proj/overlaps"
            sleep ${criticalHoldSeconds}
            rm -f "$proj/critical"
            release_lock
            echo done >> "$proj/finished"
          ) &
        done
        wait
      done`;
    const result = runBash(driver, 280_000);
    assert.equal(result.status, 0, result.stderr);
    const countLines = (file: string): number => (fs.existsSync(path.join(project, file)) ? fs.readFileSync(path.join(project, file), 'utf8').split('\n').filter((line) => line !== '').length : 0);
    return { overlaps: countLines('overlaps'), finished: countLines('finished') };
  }

  it('waiters that all find the same dead holder break its lock ONE at a time: no two jobs of a project are ever in the critical section together', () => {
    const outcome = raceForAStaleLock();
    assert.equal(outcome.finished, contenders * rounds, 'every waiter got the lock in the end');
    assert.equal(outcome.overlaps, 0, `${outcome.overlaps} times two jobs held the lock together`);
  });

  describe('the right to break a stale lock', () => {
    const projectDirectory = (): string => path.join(workDir, 'p', slug);
    const lockFile = (): string => path.join(projectDirectory(), 'lock');
    const rightFile = (pid: number | string, job: string, generation: number): string => path.join(projectDirectory(), `lock.breaking.${pid}.${job}.${generation}`);
    const listRights = (): string[] => fs.readdirSync(projectDirectory()).filter((name) => name.startsWith('lock.breaking.')).sort();
    const ageBy = (target: string, minutes: number): void => {
      const when = new Date(Date.now() - minutes * 60 * 1000);
      fs.utimesSync(target, when, when);
    };
    const deadPid = (): number => spawnSync('true').pid ?? 0;
    const aliveContent = `${process.pid}\nbox1-slow00\n`;

    /** A project whose lock is held by `lockContent`; runs `body` as the waiter job and returns its status line. */
    function runWaiter(lockContent: string, body: string): string {
      fs.mkdirSync(projectDirectory(), { recursive: true });
      fs.writeFileSync(lockFile(), lockContent);
      return runBash(`work=${workDir}; killed=0; set_paths ${workDir} ${slug} box1-mine00; ${body}; echo "returned=$?"`).stdout.trim();
    }

    it('a right held by a breaker that is ALIVE is never taken from it: the waiter yields and the lock is not touched', () => {
      const dead = deadPid();
      fs.mkdirSync(projectDirectory(), { recursive: true });
      fs.writeFileSync(rightFile(dead, 'box1-dead00', 0), aliveContent);
      ageBy(rightFile(dead, 'box1-dead00', 0), 30);
      assert.equal(runWaiter(`${dead}\nbox1-dead00\n`, 'break_stale_lock'), 'returned=1', 'however old the file is: a slow breaker is not a dead one');
      assert.equal(fs.existsSync(lockFile()), true);
      assert.deepEqual(listRights(), [`lock.breaking.${dead}.box1-dead00.0`], 'and no second right was made');
      assert.equal(fs.readFileSync(rightFile(dead, 'box1-dead00', 0), 'utf8'), aliveContent);
    });

    it('a right whose breaker is DEAD passes to the next generation at once: this waiter wins it and breaks the lock', () => {
      const dead = deadPid();
      fs.mkdirSync(projectDirectory(), { recursive: true });
      fs.writeFileSync(rightFile(dead, 'box1-dead00', 0), `${deadPid()}\nbox1-gone00\n`);
      assert.equal(runWaiter(`${dead}\nbox1-dead00\n`, 'break_stale_lock'), 'returned=0');
      assert.equal(fs.existsSync(lockFile()), false, 'the stale lock is broken');
      assert.deepEqual(listRights(), [`lock.breaking.${dead}.box1-dead00.0`, `lock.breaking.${dead}.box1-dead00.1`]);
    });

    it('a right with no breaker written is kept while it is young and passed on once it is over a minute old', () => {
      const dead = deadPid();
      fs.mkdirSync(projectDirectory(), { recursive: true });
      fs.writeFileSync(rightFile(dead, 'box1-dead00', 0), '');
      assert.equal(runWaiter(`${dead}\nbox1-dead00\n`, 'break_stale_lock'), 'returned=1', 'its creator may be a moment from writing its pid');
      assert.equal(fs.existsSync(lockFile()), true);
      ageBy(rightFile(dead, 'box1-dead00', 0), 2);
      assert.equal(runWaiter(`${dead}\nbox1-dead00\n`, 'break_stale_lock'), 'returned=0', 'its creator died before it could');
      assert.equal(fs.existsSync(lockFile()), false);
    });

    it('a lock that another job took after the dead holder was seen is NOT removed: the right names the dead holder, and the lock no longer carries it', () => {
      const dead = deadPid();
      const outcome = runWaiter(aliveContent, `break_lock_of_holder ${dead} box1-dead00`);
      assert.equal(outcome, 'returned=0');
      assert.equal(fs.readFileSync(lockFile(), 'utf8'), aliveContent, 'the live job keeps its lock');
    });

    it('a lock with no holder written is not removed while it is young — a fresh lock is empty for a moment before its pid is written — and is once it is over a minute old', () => {
      // A waiter that judged an OLD empty lock stale, stalled, and finds a lock now that a new job has just created: the right to break "nobody"
      // is won all the same, and the lock it sees is the new one, still empty.
      assert.equal(runWaiter('', "break_lock_of_holder '' ''"), 'returned=0');
      assert.equal(fs.existsSync(lockFile()), true, 'the fresh empty lock is not touched');
      assert.deepEqual(listRights(), ['lock.breaking.none.none.0']);
      // The same call once the lock has been empty for over a minute (not rewritten by runWaiter, which would make it young again).
      ageBy(lockFile(), 2);
      const outcome = runBash(`work=${workDir}; killed=0; set_paths ${workDir} ${slug} box1-mine00; break_lock_of_holder '' ''; echo "returned=$?"`);
      assert.equal(outcome.stdout.trim(), 'returned=0');
      assert.equal(fs.existsSync(lockFile()), false, 'a creator that never wrote its pid is gone for good: the lock goes');
    });

    it('no lock at all is nothing to break', () => {
      fs.mkdirSync(projectDirectory(), { recursive: true });
      const outcome = runBash(`work=${workDir}; killed=0; set_paths ${workDir} ${slug} box1-mine00; break_lock_of_holder '' ''; echo "returned=$?"`);
      assert.equal(outcome.stdout.trim(), 'returned=0');
      assert.equal(fs.existsSync(lockFile()), false);
    });

    it('a right whose breaker died and whose pid went to another process is passed on once the breaker\'s job has an exit record — a live pid alone does not keep it', () => {
      const dead = deadPid();
      fs.mkdirSync(projectDirectory(), { recursive: true });
      // The breaker's pid is alive (this test process: standing in for the long-lived process that got the number), its job is not over.
      fs.writeFileSync(rightFile(dead, 'box1-dead00', 0), `${process.pid}\nbox1-reused0\n`);
      assert.equal(runWaiter(`${dead}\nbox1-dead00\n`, 'break_stale_lock'), 'returned=1', 'a breaker whose job is still running keeps its right');
      assert.equal(fs.existsSync(lockFile()), true);
      writeFile(path.join(projectDirectory(), 'jobs', 'box1-reused0'), 'exit', '137\n');
      assert.equal(runWaiter(`${dead}\nbox1-dead00\n`, 'break_stale_lock'), 'returned=0', 'its job is over: the pid is not the breaker any more');
      assert.equal(fs.existsSync(lockFile()), false);
      assert.deepEqual(listRights(), [`lock.breaking.${dead}.box1-dead00.0`, `lock.breaking.${dead}.box1-dead00.1`]);
    });

    it('a lock that is not stale is left alone and no right is made', () => {
      assert.equal(runWaiter(aliveContent, 'break_stale_lock'), 'returned=0');
      assert.equal(fs.readFileSync(lockFile(), 'utf8'), aliveContent);
      assert.deepEqual(listRights(), []);
    });

    it('what the lock file says never decides a path: a holder name with a slash in it names nothing outside the project folder', () => {
      const dead = deadPid();
      assert.equal(runWaiter(`${dead}\n../../escape\n`, 'break_stale_lock'), 'returned=0');
      assert.equal(fs.existsSync(lockFile()), false, 'the lock is still broken');
      assert.deepEqual(listRights(), [`lock.breaking.${dead}.none.0`]);
      assert.equal(fs.existsSync(path.join(workDir, 'escape.0')), false);
    });

    it('a job that takes the lock clears the rights to break it: they name holders that are gone', () => {
      fs.mkdirSync(projectDirectory(), { recursive: true });
      fs.writeFileSync(rightFile(123456, 'box1-dead00', 0), aliveContent);
      fs.writeFileSync(rightFile(123456, 'box1-dead00', 1), aliveContent);
      const result = runBash(`work=${workDir}; killed=0; set_paths ${workDir} ${slug} box1-mine00; acquire_lock; echo "held=$lock_held"`);
      assert.equal(result.stdout.trim(), 'held=1');
      assert.deepEqual(listRights(), []);
    });

    it('waiters that find a lock AND the right to break it both left by dead processes still break it ONE at a time', () => {
      const outcome = raceForAStaleLock({ withDeadBreaker: true });
      assert.equal(outcome.finished, contenders * rounds, 'every waiter got the lock in the end');
      assert.equal(outcome.overlaps, 0, `${outcome.overlaps} times two jobs held the lock together`);
    });
  });

  it('the lock is made with an exclusive create that has ONE winner among simultaneous attempts — which `mkdir` of the uutils coreutils (Ubuntu\'s default) does not', () => {
    const result = runBash(`
      work=${workDir}; set_paths ${workDir} ${slug} box1-race00
      mkdir -p "$proj"; bad=0
      for round in $(seq 1 ${exclusiveCreateRounds}); do
        rm -f "$lock"; rm -f "$proj/wins"
        for attempt in 1 2 3 4 5; do ( create_lock_file "$lock" && echo won >> "$proj/wins" ) & done
        wait
        [ "$(wc -l < "$proj/wins")" -eq 1 ] || bad=$((bad + 1))
      done
      echo "bad=$bad"`, 120_000);
    assert.equal(result.stdout.trim(), 'bad=0', result.stderr);
  });

  it('the script never takes a lock with mkdir: on a machine whose mkdir is exclusive a slip back would pass every race, so the text is checked', () => {
    const code = fs.readFileSync(scriptPath, 'utf8').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    assert.ok(!/mkdir\s+(-p\s+)?"\$(lock|proj\/lock)/.test(code), 'a lock or its mutex is made by mkdir');
    assert.match(code, /create_lock_file\(\) \{[^}]*set -C/, 'the lock is made with the shell\'s exclusive create');
  });

  it('a lock is released only while it is still ours: one that was broken as stale and taken by another job is not removed', () => {
    const project = path.join(workDir, 'p', slug);
    fs.mkdirSync(project, { recursive: true });
    const lockFile = path.join(project, 'lock');
    // Ours: made by this shell's own acquire.
    const own = runBash(`work=${workDir}; killed=0; set_paths ${workDir} ${slug} box1-mine00; acquire_lock; [ -e "$lock" ] && echo held; release_lock; [ -e "$lock" ] && echo STILL || echo released`);
    assert.equal(own.stdout.trim(), 'held\nreleased');
    // Someone else's: another job holds it now.
    fs.writeFileSync(lockFile, `${process.pid}\nbox1-other0\n`);
    const foreign = runBash(`work=${workDir}; killed=0; set_paths ${workDir} ${slug} box1-mine00; lock_held=1; release_lock; [ -e "$lock" ] && echo kept || echo REMOVED`);
    assert.equal(foreign.stdout.trim(), 'kept');
    assert.equal(fs.readFileSync(lockFile, 'utf8'), `${process.pid}\nbox1-other0\n`);
  });

  it('a lock whose holder is alive is never broken, and one with a dead process or a finished job\'s name is', () => {
    const project = path.join(workDir, 'p', slug);
    fs.mkdirSync(path.join(project, 'jobs', 'box1-done00'), { recursive: true });
    writeFile(path.join(project, 'jobs', 'box1-done00'), 'exit', '0\n');
    const probe = (lockPid: string, lockJob: string): string => {
      fs.writeFileSync(path.join(project, 'lock'), `${lockPid}\n${lockJob}\n`);
      return runBash(`set_paths ${workDir} ${slug} box1-race00; check_lock_is_stale && echo stale || echo held`).stdout.trim();
    };
    assert.equal(probe(`${process.pid}`, 'box1-running'), 'held');
    assert.equal(probe(`${spawnSync('true').pid}`, 'box1-gone00'), 'stale', 'its process is gone');
    assert.equal(probe(`${process.pid}`, 'box1-done00'), 'stale', 'its job has an exit record');
  });

  it('a lock with no holder written is left alone while it is young and broken once it is over a minute old', () => {
    const project = path.join(workDir, 'p', slug);
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'lock'), '');
    const isStale = (): string => runBash(`set_paths ${workDir} ${slug} box1-race00; check_lock_is_stale && echo stale || echo held`).stdout.trim();
    assert.equal(isStale(), 'held', 'its creator may be a moment from writing its pid');
    const old = new Date(Date.now() - 2 * 60 * 1000);
    fs.utimesSync(path.join(project, 'lock'), old, old);
    assert.equal(isStale(), 'stale', 'its creator died before it could');
  });
});
