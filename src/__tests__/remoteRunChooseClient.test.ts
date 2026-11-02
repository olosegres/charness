/**
 * @description The wiring of the wait for a paired runner in `commands.ts chooseClient`: the catalog is read AGAIN at every attempt, so a
 * runner paused or removed from the hub while the command waits is seen as it is then — reconnecting it afterwards starts nothing. The
 * runners here are paired ones whose link nobody listens on: they are offline without any ssh call, so the whole path (reload → clients →
 * probe → pick → wait plan → wait loop) runs in-process against a fake clock.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chooseClient, type CommandContext } from '../remoteRun/commands';
import { RemoteRunError } from '../remoteRun/remoteRunError';
import type { RunnerConfig, RunnersConfig } from '../remoteRun/runnersConfig';

const runnerId = 'a1b2c3d4e5f6';
const snapshotText = 'os=Linux\nos_name=Ubuntu\npueue=4.0.4\ncap_android=no\ncap_ios=no\ncap_docker=no\ncap_playwright=yes\ncap_playwright_detail=chromium\n';
const seenAtMs = Date.UTC(2026, 10, 1, 14, 2);

let root = '';
let stderr: string[] = [];
let nowMs = 0;
let sleeps: number[] = [];
let loads = 0;
/** What `loadRunners` returns at each look (the last repeats); a sleep may change what comes next. */
let catalogs: RunnersConfig[] = [];
let onSleep: (sleepNumber: number) => void = () => undefined;
/** What the loop gave `watchInterrupts` while it runs; a test calls it to interrupt. `null` once the loop has stopped listening. */
let interruptHandler: ((signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP') => void) | null = null;

function createPairedRunner(overrides: { isPausedByHub?: boolean; name?: string } = {}): RunnerConfig {
  // No link directory exists under `root/hub`: the link accepts nothing, the runner is offline, and no ssh is ever started.
  return { name: overrides.name ?? 'mac', ssh: `charness-runner-${runnerId}`, workDir: '/w', paired: { runnerId, hubDir: path.join(root, 'hub'), isPausedByHub: overrides.isPausedByHub ?? false, os: 'Ubuntu 24.04' } };
}

function createContext(): CommandContext {
  return {
    io: { stdout: () => undefined, stderr: (text) => { stderr.push(text); }, cwd: root, env: {}, homeDir: root },
    config: { runners: [] },
    cacheDir: path.join(root, 'cache'),
    script: { name: 'runner-test.sh', text: '' },
    leaseMs: 3000,
    now: () => nowMs,
    loadRunners: () => {
      loads += 1;
      return catalogs[Math.min(loads, catalogs.length) - 1];
    },
    runnerPollMs: 10_000,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
      onSleep(sleeps.length);
    },
    watchInterrupts: (onInterrupt) => {
      interruptHandler = onInterrupt;
      return () => { interruptHandler = null; };
    },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'choose-client-'));
  fs.mkdirSync(path.join(root, 'cache'));
  fs.writeFileSync(path.join(root, 'cache', 'mac.probe.json'), JSON.stringify({ seenAtMs, text: snapshotText }));
  stderr = [];
  nowMs = 1_000_000;
  sleeps = [];
  loads = 0;
  catalogs = [];
  onSleep = () => undefined;
  interruptHandler = null;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the wait for a paired runner reads the catalog again at every attempt', () => {
  it('the runner is offline with the capability: it is waited for, the wait is announced once, and the catalog is read at the first attempt and again at each look', async () => {
    catalogs = [{ runners: [createPairedRunner()] }];
    onSleep = (sleepNumber) => {
      if (sleepNumber === 2) throw new Error('the wait went on past two looks — stop here');
    };
    await assert.rejects(chooseClient(createContext(), { runner: null, needs: 'playwright', waitSeconds: 900 }), /the wait went on past two looks/);
    assert.deepEqual(sleeps, [10_000, 10_000]);
    assert.equal(loads, 2, 'read at the first attempt and once more after the first sleep');
    assert.equal(stderr.filter((line) => line.includes('waiting for a runner with playwright')).length, 1);
    assert.match(stderr.join(''), /waiting for a runner with playwright \(mac offline since 2026-11-01 14:02 UTC\)/);
  });

  it('an interrupt that reaches the loop through the command\'s context ends the wait with the code of the signal, and the loop stops listening', async () => {
    catalogs = [{ runners: [createPairedRunner()] }];
    onSleep = (sleepNumber) => {
      if (sleepNumber === 2) interruptHandler?.('SIGTERM');
    };
    await assert.rejects(chooseClient(createContext(), { runner: null, needs: 'playwright', waitSeconds: 900 }), (error: Error) => error instanceof RemoteRunError && error.exitCode === 143 && /interrupted while waiting for a runner/.test(error.message));
    assert.deepEqual(sleeps, [10_000, 10_000], 'no look after the interrupt');
    assert.equal(interruptHandler, null);
  });

  it('a runner PAUSED from the hub while the command waits is no longer waited for — it would be skipped when it came back', async () => {
    catalogs = [{ runners: [createPairedRunner()] }, { runners: [createPairedRunner({ isPausedByHub: true })] }];
    await assert.rejects(chooseClient(createContext(), { runner: null, needs: 'playwright', waitSeconds: 900 }), (error: Error) => {
      assert.ok(error instanceof RemoteRunError);
      assert.equal(error.exitCode, 125);
      assert.match(error.message, /^no online runner can do "playwright"\n/);
      assert.match(error.message, /mac — offline \(the runner is not connected\) · paused from the hub · /);
      assert.match(error.message, /waited 10 s for a runner with "playwright" to come back — none did$/);
      return true;
    });
    assert.deepEqual(sleeps, [10_000], 'one look after the pause, and the wait ended there');
    assert.equal(loads, 2);
  });

  it('a runner REMOVED from the hub while the command waits: nothing is left to wait for', async () => {
    catalogs = [{ runners: [createPairedRunner()] }, { runners: [] }];
    await assert.rejects(chooseClient(createContext(), { runner: null, needs: 'playwright', waitSeconds: 900 }), (error: Error) => error instanceof RemoteRunError && error.exitCode === 125 && /^no online runner can do "playwright"/.test(error.message) && /waited 10 s/.test(error.message));
    assert.deepEqual(sleeps, [10_000]);
  });

  it('a runner paired again under the same name (a new link) is a new client at the next look: its own link\'s last-seen time is what the failure shows, not the old one\'s', async () => {
    const paired = createPairedRunner();
    const newRunnerId = 'ffffffffffff';
    const newHubDir = path.join(root, 'other-hub');
    const pairedAgain = { ...paired, paired: { runnerId: newRunnerId, hubDir: newHubDir, isPausedByHub: false, os: 'Ubuntu 24.04' } };
    // The new link left a heartbeat of its own (the gate has gone: offline); the old one has none, so a client that stayed on the old
    // link could only show the time of the last probe snapshot (14:02).
    const linkDir = path.join(newHubDir, 'link');
    fs.mkdirSync(linkDir, { recursive: true });
    fs.writeFileSync(path.join(linkDir, `${newRunnerId}.json`), JSON.stringify({ pid: 4242, sinceMs: Date.UTC(2026, 10, 1, 16, 0), lastBeatMs: Date.UTC(2026, 10, 1, 16, 30), endedAtMs: Date.UTC(2026, 10, 1, 16, 31) }));
    catalogs = [{ runners: [paired] }, { runners: [pairedAgain] }];
    await assert.rejects(chooseClient(createContext(), { runner: null, needs: 'playwright', waitSeconds: 15 }), (error: Error) => {
      assert.ok(error instanceof RemoteRunError);
      assert.match(error.message, /mac — offline \(the runner is not connected\) · last seen 2026-11-01 16:31 UTC/, 'the new link\'s own end time');
      assert.doesNotMatch(error.message, /last seen 2026-11-01 14:02 UTC/);
      assert.doesNotMatch(error.message, /paused from the hub/);
      return true;
    });
  });

  it('--runner-wait 0 reads the catalog once and fails at once, as without a wait', async () => {
    catalogs = [{ runners: [createPairedRunner()] }];
    await assert.rejects(chooseClient(createContext(), { runner: null, needs: 'playwright', waitSeconds: 0 }), (error: Error) => error instanceof RemoteRunError && error.exitCode === 125 && !error.message.includes('waited'));
    assert.deepEqual([loads, sleeps], [1, []]);
  });

  it('a runner named that the catalog does not have is a usage mistake (2) naming the runners that are', async () => {
    catalogs = [{ runners: [createPairedRunner()] }];
    await assert.rejects(chooseClient(createContext(), { runner: 'nope', needs: null, waitSeconds: 0 }), (error: Error) => error instanceof RemoteRunError && error.exitCode === 2 && error.message === 'no runner named "nope" (configured: mac)');
  });
});
