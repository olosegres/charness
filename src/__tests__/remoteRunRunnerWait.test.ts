/**
 * @description The wait of `charness remote-run --needs <capability>` for an offline PAIRED runner (`remoteRun/runnerWait.ts`,
 * `runnerWaitTiming.ts`): what is worth waiting for (a paired runner that, when last seen, had the capability and Pueue and is not
 * paused — never a hand-made one, a named one or a capability nobody has), the loop that announces once, looks again every poll and gives
 * up after `--runner-wait` (`0` = at once), an interrupt that ends it with the shell's code, and the test window of the poll.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbeOutput, type RunnerReport } from '../remoteRun/probe';
import { RemoteRunError } from '../remoteRun/remoteRunError';
import { pickRunner } from '../remoteRun/runners';
import type { RunnersConfig } from '../remoteRun/runnersConfig';
import { chooseRunnerWithWait, formatWaitDuration, minWaitAttemptMs, planRunnerWait, type RunnerAttempt } from '../remoteRun/runnerWait';
import { defaultRunnerWaitSeconds, readRunnerWaitPollMs, runnerWaitPollMinMs, runnerWaitPollMs } from '../remoteRun/runnerWaitTiming';

const pairedLink = { runnerId: 'a1b2c3d4e5f6', hubDir: '/h', isPausedByHub: false };
const config: RunnersConfig = {
  runners: [
    { name: 'plain', ssh: 'u@plain.example', workDir: '/w' },
    { name: 'mac', ssh: 'charness-runner-a1b2c3d4e5f6', workDir: '/w', paired: pairedLink },
    { name: 'box1', ssh: 'charness-runner-b1b2c3d4e5f6', workDir: '/w', paired: { ...pairedLink, runnerId: 'b1b2c3d4e5f6' } },
  ],
};

const withAndroid = 'os=Linux\npueue=4.0.4\ncap_android=yes\ncap_ios=no\ncap_docker=no\ncap_playwright=no\n';
const withoutAndroid = 'os=Linux\npueue=4.0.4\ncap_android=no\ncap_ios=no\ncap_docker=no\ncap_playwright=no\n';
const seenAtMs = Date.UTC(2026, 10, 1, 14, 2);

function offline(name: string, snapshot: string | null, extra: Partial<Extract<RunnerReport, { status: 'offline' }>> = {}): RunnerReport {
  return { name, status: 'offline', reason: 'the runner is not connected', lastSeenAtMs: snapshot === null ? null : seenAtMs, lastProbe: snapshot === null ? null : parseProbeOutput(snapshot), groupLimits: {}, isPausedByHub: false, ...extra };
}

function online(name: string, probeText: string): RunnerReport {
  return { name, status: 'online', probe: parseProbeOutput(probeText), groupLimits: {}, isPausedByHub: false };
}

describe('what is worth waiting for', () => {
  it('a paired runner that is offline and had the capability when last seen — named, with since when', () => {
    const plan = planRunnerWait(config, [offline('plain', withAndroid), offline('mac', withAndroid), online('box1', withoutAndroid)], { runner: null, needs: 'android' });
    assert.deepEqual(plan?.runnerNames, ['mac']);
    assert.equal(plan?.description, 'mac offline since 2026-11-01 14:02 UTC');
  });

  it('several: all of them are named', () => {
    const plan = planRunnerWait(config, [offline('mac', withAndroid), offline('box1', withAndroid)], { runner: null, needs: 'android' });
    assert.deepEqual(plan?.runnerNames, ['mac', 'box1']);
  });

  it('nothing is waited for when no capability is needed, or a runner is named', () => {
    const reports = [offline('mac', withAndroid)];
    assert.equal(planRunnerWait(config, reports, { runner: null, needs: null }), null);
    assert.equal(planRunnerWait(config, reports, { runner: 'mac', needs: 'android' }), null);
  });

  it('a hand-made runner is never waited for — its offline state is not part of a design', () => {
    assert.equal(planRunnerWait(config, [offline('plain', withAndroid)], { runner: null, needs: 'android' }), null);
  });

  it('a runner that never had the capability, was never seen (nothing is known of it), or had no Pueue is not waited for', () => {
    assert.equal(planRunnerWait(config, [offline('mac', withoutAndroid)], { runner: null, needs: 'android' }), null);
    assert.equal(planRunnerWait(config, [offline('mac', null)], { runner: null, needs: 'android' }), null);
    assert.equal(planRunnerWait(config, [offline('mac', 'os=Linux\npueue=missing\ncap_android=yes\n')], { runner: null, needs: 'android' }), null);
  });

  it('a paused runner is not waited for — from the hub, or paused on the runner when it was last seen', () => {
    assert.equal(planRunnerWait(config, [offline('mac', withAndroid, { isPausedByHub: true })], { runner: null, needs: 'android' }), null);
    assert.equal(planRunnerWait(config, [offline('mac', `${withAndroid}paused=yes\n`)], { runner: null, needs: 'android' }), null);
  });

  it('an online runner is never a reason to wait (it is picked, or it lacks the capability)', () => {
    assert.equal(planRunnerWait(config, [online('mac', withAndroid)], { runner: null, needs: 'android' }), null);
  });
});

describe('the pick the plan follows', () => {
  it('an offline paired runner with the capability: the pick fails (125) and the plan says to wait', () => {
    const reports = [offline('mac', withAndroid)];
    const pick = pickRunner(config, reports, { runner: null, needs: 'android' });
    assert.ok(!pick.ok && pick.exitCode === 125 && pick.message.startsWith('no online runner can do "android"\n'));
    assert.notEqual(planRunnerWait(config, reports, { runner: null, needs: 'android' }), null);
  });
});

describe('formatWaitDuration', () => {
  it('says seconds under a minute, minutes, hours — the words of the command line', () => {
    assert.deepEqual([10, 90, 900, 3600, 5400, 7200].map(formatWaitDuration), ['10 s', '1 min 30 s', '15 min', '1 h', '1 h 30 min', '2 h']);
  });
});

/** What an attempt does: answers, or (a function) first spends time or changes the world — as a slow probe would — and then answers. */
type FakeAnswer = RunnerAttempt<string> | ((world: FakeWorld) => RunnerAttempt<string>);

interface FakeWorld {
  nowMs: number;
  said: string[];
  sleeps: number[];
  attempts: number;
  /** The time each attempt was told it had: `null` for the first, then what was left of the wait. */
  budgets: Array<number | null>;
  /** The attempt's answer by number (from 1); the last one repeats. */
  answers: FakeAnswer[];
  interruptAtSleep: { sleepNumber: number; signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' } | null;
}

function createWorld(answers: FakeAnswer[]): FakeWorld {
  return { nowMs: 1_000_000, said: [], sleeps: [], attempts: 0, budgets: [], answers, interruptAtSleep: null };
}

function runLoop(world: FakeWorld, options: { waitSeconds: number; needs?: 'android' | null; pollMs?: number }): Promise<string> {
  return chooseRunnerWithWait<string>({
    attempt: async (budgetMs) => {
      world.attempts += 1;
      world.budgets.push(budgetMs);
      const answer = world.answers[Math.min(world.attempts, world.answers.length) - 1];
      return typeof answer === 'function' ? answer(world) : answer;
    },
    needs: options.needs === undefined ? 'android' : options.needs,
    waitSeconds: options.waitSeconds,
    pollMs: options.pollMs ?? 10_000,
    now: () => world.nowMs,
    sleep: async (ms) => {
      world.sleeps.push(ms);
      world.nowMs += ms;
      return world.interruptAtSleep !== null && world.interruptAtSleep.sleepNumber === world.sleeps.length ? world.interruptAtSleep.signal : null;
    },
    say: (line) => world.said.push(line),
  });
}

const waitingFailure: RunnerAttempt<string> = {
  ok: false,
  failure: { ok: false, exitCode: 125, message: 'no online runner can do "android"\nmac — offline' },
  wait: { runnerNames: ['mac'], description: 'mac offline since 2026-11-01 14:02 UTC' },
};
const hopelessFailure: RunnerAttempt<string> = { ok: false, failure: { ok: false, exitCode: 125, message: 'no online runner can do "android"' }, wait: null };
const chosen: RunnerAttempt<string> = { ok: true, choice: 'mac' };

describe('the wait loop', () => {
  it('waits for the runner, says so ONCE, looks again every poll, and goes on with the runner when it is back', async () => {
    const world = createWorld([waitingFailure, waitingFailure, waitingFailure, chosen]);
    assert.equal(await runLoop(world, { waitSeconds: 900 }), 'mac');
    assert.equal(world.attempts, 4);
    assert.deepEqual(world.sleeps, [10_000, 10_000, 10_000]);
    assert.equal(world.said.length, 1);
    assert.equal(world.said[0], 'waiting for a runner with android (mac offline since 2026-11-01 14:02 UTC) — looking again every 10 s, up to 15 min');
  });

  it('says the poll in the unit it is in: seconds, or milliseconds below a second (the test windows)', async () => {
    const world = createWorld([waitingFailure, chosen]);
    await runLoop(world, { waitSeconds: 60, pollMs: 500 });
    assert.match(world.said[0], /looking again every 500 ms, up to 1 min$/);
    const seconds = createWorld([waitingFailure, chosen]);
    await runLoop(seconds, { waitSeconds: 60, pollMs: 2000 });
    assert.match(seconds.said[0], /looking again every 2 s, up to 1 min$/);
  });

  it('a runner that is there at once: no waiting, no announcement', async () => {
    const world = createWorld([chosen]);
    assert.equal(await runLoop(world, { waitSeconds: 900 }), 'mac');
    assert.deepEqual([world.sleeps, world.said], [[], []]);
  });

  it('gives up when --runner-wait ends: the pick\'s own message and exit code, and how long it waited', async () => {
    const world = createWorld([waitingFailure]);
    await assert.rejects(runLoop(world, { waitSeconds: 25 }), (error: Error) => {
      assert.ok(error instanceof RemoteRunError);
      assert.equal(error.exitCode, 125);
      assert.match(error.message, /^no online runner can do "android"\nmac — offline\nwaited 25 s for a runner with "android" to come back — none did$/);
      return true;
    });
    assert.deepEqual(world.sleeps, [10_000, 10_000, 5_000], 'the last sleep is cut to what is left of the wait');
  });

  it('every attempt of the wait is told what is left of it, so its probe can end in time — the first one, before any waiting, is not', async () => {
    const world = createWorld([waitingFailure]);
    await assert.rejects(runLoop(world, { waitSeconds: 25 }), RemoteRunError);
    assert.deepEqual(world.budgets, [null, 15_000, 5_000]);
  });

  it('with less than a second left no attempt is started — the wait is over, a probe could not answer in that time', async () => {
    assert.equal(minWaitAttemptMs, 1000);
    const world = createWorld([waitingFailure]);
    await assert.rejects(runLoop(world, { waitSeconds: 10, pollMs: 9_500 }), (error: Error) => error instanceof RemoteRunError && /waited \d+ s for a runner with "android" to come back — none did$/.test(error.message));
    assert.equal(world.attempts, 1, 'the half second that was left bought no second attempt');
    assert.deepEqual(world.sleeps, [9_500]);
  });

  it('a runner that answers only AFTER the deadline is refused — the job is not started late, however good the answer', async () => {
    const answersAfterDeadline = (world: FakeWorld): RunnerAttempt<string> => {
      world.nowMs += 30_000;
      return chosen;
    };
    const world = createWorld([waitingFailure, answersAfterDeadline]);
    await assert.rejects(runLoop(world, { waitSeconds: 20 }), (error: Error) => {
      assert.ok(error instanceof RemoteRunError);
      assert.equal(error.exitCode, 125);
      assert.ok(error.message.startsWith('no online runner can do "android"\nmac — offline\n'), error.message);
      assert.match(error.message, /waited 40 s for a runner with "android" to come back — one answered only after the wait had ended, so the job was not started$/);
      return true;
    });
    assert.equal(world.attempts, 2);
  });

  it('a runner that answers in time, with the whole budget used, is still taken', async () => {
    const answersJustInTime = (world: FakeWorld): RunnerAttempt<string> => {
      world.nowMs += 10_000;
      return chosen;
    };
    const world = createWorld([waitingFailure, answersJustInTime]);
    assert.equal(await runLoop(world, { waitSeconds: 20 }), 'mac');
  });

  it('--runner-wait 0: 125 at once — nothing announced, nothing slept, no "waited" line', async () => {
    const world = createWorld([waitingFailure]);
    await assert.rejects(runLoop(world, { waitSeconds: 0 }), (error: Error) => error instanceof RemoteRunError && error.exitCode === 125 && !error.message.includes('waited'));
    assert.deepEqual([world.attempts, world.sleeps, world.said], [1, [], []]);
  });

  it('nothing worth waiting for (no runner has the capability): 125 at once even with a long --runner-wait', async () => {
    const world = createWorld([hopelessFailure]);
    await assert.rejects(runLoop(world, { waitSeconds: 900 }), (error: Error) => error instanceof RemoteRunError && error.exitCode === 125 && error.message === 'no online runner can do "android"');
    assert.deepEqual([world.attempts, world.sleeps, world.said], [1, [], []]);
  });

  it('when the plan turns hopeless while waiting (the runner was removed, or paused), the wait ends at once and says how long it had waited', async () => {
    const world = createWorld([waitingFailure, hopelessFailure]);
    await assert.rejects(runLoop(world, { waitSeconds: 900 }), (error: Error) => error instanceof RemoteRunError && /waited 10 s/.test(error.message));
    assert.equal(world.said.length, 1);
  });

  it('an interrupt while waiting ends it with the exit code of the signal (130 / 143 / 129) and no more attempts', async () => {
    for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
      const world = createWorld([waitingFailure]);
      world.interruptAtSleep = { sleepNumber: 2, signal };
      await assert.rejects(runLoop(world, { waitSeconds: 900 }), (error: Error) => error instanceof RemoteRunError && error.exitCode === exitCode && /interrupted while waiting/.test(error.message), signal);
      assert.equal(world.attempts, 2, 'no attempt after the interrupt');
    }
  });
});

describe('the poll', () => {
  it('is 10 s and the wait 15 min unless the command line says otherwise', () => {
    assert.equal(runnerWaitPollMs, 10_000);
    assert.equal(defaultRunnerWaitSeconds, 900);
    assert.equal(readRunnerWaitPollMs({}), runnerWaitPollMs);
  });

  it('the test seam may only SHORTEN it, and not below its floor', () => {
    const env = (value: object | string): NodeJS.ProcessEnv => ({ CHARNESS_TEST_TIMINGS: typeof value === 'string' ? value : JSON.stringify(value) });
    assert.equal(readRunnerWaitPollMs(env({ remoteRunRunnerPollMs: 1000 })), 1000);
    assert.equal(readRunnerWaitPollMs(env({ remoteRunRunnerPollMs: runnerWaitPollMinMs })), runnerWaitPollMinMs);
    for (const rejected of [{ remoteRunRunnerPollMs: runnerWaitPollMs + 1 }, { remoteRunRunnerPollMs: runnerWaitPollMinMs - 1 }, { remoteRunRunnerPollMs: 1000.5 }, { remoteRunRunnerPollMs: '1000' }, { otherKey: 1000 }, '{nope', '[]']) {
      assert.equal(readRunnerWaitPollMs(env(rejected)), runnerWaitPollMs, JSON.stringify(rejected));
    }
  });
});
