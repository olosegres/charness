/**
 * @description Coverage for `src/selfUpdate/updateEngine.ts` against fakes for every port (a fake clock and timers, an in-memory
 * state, recording sources, a scripted idle verdict): the npm flow (the 4 h hold, the idle wait, «Update now», deprecated, a major, a Node that
 * is too old, a prefix that is read-only, a failed install, a failed self-check and rollback), the checkout flow (plain, hot with its
 * build deadline, a migration guide held back), the boot step (the "Updated" line, a manual version change, the one-time announcement,
 * a rolled-back update, the confirmation), a check that keeps failing, `off` / `notify`, a newer install already on disk and a
 * stale supervisor. Each is a VERIFICATION row of the auto-update plan.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { bootConfirmMs, checkIntervalMs, firstCheckDelayMs, hotBuildDeadlineMs, idlePollIntervalMs, npmHoldMs } from '../selfUpdate/constants';
import type { GitApplyResult, GitSource } from '../selfUpdate/gitSource';
import type { HostLock } from '../selfUpdate/hostLock';
import type { HotSupervisorRecord, SupervisorSignalResult } from '../selfUpdate/hotSupervisor';
import type { InstallKind } from '../selfUpdate/installKind';
import type { NpmSource } from '../selfUpdate/npmSource';
import { UpdateSourceError } from '../selfUpdate/npmSource';
import type { LastRunVersion, SelfUpdateRecord } from '../selfUpdate/types';
import { createUpdateEngine, type UpdateEngine, type UpdateEngineDeps } from '../selfUpdate/updateEngine';
import type { UpdateSettings } from '../selfUpdate/updateModes';
import type { UpdateMessage } from '../selfUpdate/updateMessages';
import type { UpdatePendingMarker } from '../selfUpdate/updatePending';
import type { GitCheck, IdleVerdict, NpmLatest } from '../selfUpdate/updatePolicy';

const startTime = 1_800_000_000_000;
const busy: IdleVerdict = { isIdle: false, reason: 'working' };
const idle: IdleVerdict = { isIdle: true };

interface Timer {
  id: number;
  dueAt: number;
  callback: () => void;
}

interface HarnessOptions {
  installKind?: InstallKind;
  isHotMode?: boolean;
  running?: LastRunVersion;
  settings?: Partial<UpdateSettings>;
  latest?: NpmLatest;
  gitCheck?: GitCheck;
  record?: SelfUpdateRecord;
  lastRun?: LastRunVersion;
  marker?: UpdatePendingMarker;
  changelog?: string | null;
  installedVersion?: string | null;
  runningNode?: string;
  supervisorRecord?: HotSupervisorRecord | null;
  supervisorStale?: string[];
  reexecResult?: SupervisorSignalResult;
}

const npmGlobal: InstallKind = { kind: 'npmGlobal', prefix: '/home/u/.npm-global' };
const checkout: InstallKind = { kind: 'checkout', root: '/srv/charness' };

const changelog = [
  '# Changelog',
  '',
  '## 3.5.0 — 2026-10-24',
  '',
  '**A new board.** Details.',
  '',
  '### Upgrading',
  '- **Rename the old variables.** Before 4.0.',
  '',
  '## 3.4.0 — 2026-10-20',
  '',
  '**Old news.** x',
  '',
].join('\n');

function createHarness(options: HarnessOptions = {}) {
  let now = startTime;
  let nextTimerId = 1;
  const timers: Timer[] = [];
  const posted: UpdateMessage[] = [];
  const log: string[] = [];
  const calls: string[] = [];
  let record: SelfUpdateRecord = options.record ?? {};
  let lastRun: LastRunVersion | undefined = options.lastRun;
  let marker: UpdatePendingMarker | null = options.marker ?? null;
  const settings: UpdateSettings = { autoUpdate: 'on', whatsNew: true, ...options.settings };
  const state = { idleVerdict: busy as IdleVerdict, idleRequests: [] as boolean[], installedVersion: options.installedVersion ?? null };
  const control = {
    latest: options.latest ?? { version: '3.5.0', engines: '>=22.12', isDeprecated: false },
    gitCheck: options.gitCheck,
    npmInstallError: null as Error | null,
    npmRollbackError: null as Error | null,
    selfCheck: { ok: true, detail: '' },
    gitApply: { status: 'updated', from: 'a1b2c3d', to: 'd4e5f6a', migrationGuides: [] } as GitApplyResult,
    gitRollbackError: null as Error | null,
    gitApplyError: null as Error | null,
    /** What the pulled range changed: a compiled source by default, which `tsc -w` turns into a worker reload by itself. */
    changedFiles: ['src/bot.ts'],
    changedFilesError: null as Error | null,
    reloadError: null as Error | null,
    lockHeld: false,
    checkError: null as Error | null,
    restartError: null as Error | null,
    supervisorStale: options.supervisorStale ?? [],
    supervisorRecord: options.supervisorRecord === undefined ? null : options.supervisorRecord,
    reexecResult: options.reexecResult ?? 'signaled',
    commitCount: 12 as number | null,
    changelogDiff: '',
    markerAtRestart: null as UpdatePendingMarker | null,
  };

  const npm: NpmSource = {
    getLatest: async () => {
      calls.push('npm.getLatest');
      if (control.checkError) throw control.checkError;
      return control.latest;
    },
    install: async (version, installOptions) => {
      calls.push(`npm.install ${version}${installOptions?.isRollback ? ' rollback' : ''}`);
      const error = installOptions?.isRollback ? control.npmRollbackError : control.npmInstallError;
      if (error) throw error;
    },
  };
  const git: GitSource = {
    check: async () => {
      calls.push('git.check');
      if (control.checkError) throw control.checkError;
      if (!control.gitCheck) throw new Error('no git check scripted');
      return control.gitCheck;
    },
    apply: async ({ holdBreaking }) => {
      calls.push(`git.apply${holdBreaking ? ' hold' : ''}`);
      assert.ok(marker !== null, 'the pending marker is written BEFORE the pull');
      if (control.gitApplyError) throw control.gitApplyError;
      return control.gitApply;
    },
    getChangelogDiff: async () => control.changelogDiff,
    getChangedFiles: async (from, to) => {
      calls.push(`git.changedFiles ${from} ${to}`);
      if (control.changedFilesError) throw control.changedFilesError;
      return control.changedFiles;
    },
    reloadHotWorker: async () => {
      calls.push('git.reloadHotWorker');
      if (control.reloadError) throw control.reloadError;
    },
    rollback: async ({ from, to, isHot }) => {
      calls.push(`git.rollback ${from} ${to}${isHot ? ' hot' : ''}`);
      if (control.gitRollbackError) throw control.gitRollbackError;
    },
  };
  const lock: HostLock = { release: () => calls.push('lock.release') };

  const deps: UpdateEngineDeps = {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer: Timer = { id: nextTimerId++, dueAt: now + delayMs, callback };
      timers.push(timer);
      return timer.id;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index !== -1) timers.splice(index, 1);
    },
    log: (line) => log.push(line),
    getSettings: () => settings,
    state: {
      getRecord: () => record,
      setRecord: (next) => {
        record = next;
      },
      getLastRun: () => lastRun,
      setLastRun: async (next) => {
        lastRun = next;
      },
    },
    running: options.running ?? { version: '3.4.0', commit: null },
    runningNode: options.runningNode ?? '22.23.3',
    installKind: options.installKind ?? npmGlobal,
    isHotMode: options.isHotMode ?? false,
    npm,
    git: options.installKind?.kind === 'checkout' ? git : null,
    hostLock: { acquire: () => (control.lockHeld ? null : lock) },
    readInstalledVersion: () => state.installedVersion,
    readInstalledChangelog: () => (options.changelog === undefined ? changelog : options.changelog),
    countCommits: async () => control.commitCount,
    getIdleVerdict: (isUserRequested) => {
      state.idleRequests.push(isUserRequested);
      return state.idleVerdict;
    },
    postToGeneral: async (message) => {
      posted.push(message);
    },
    runSelfCheck: async (expectVersion) => {
      calls.push(`selfCheck ${expectVersion ?? ''}`.trim());
      return control.selfCheck;
    },
    restartInPlace: async () => {
      calls.push('restart');
      control.markerAtRestart = marker;
      if (control.restartError) throw control.restartError;
    },
    reexecTarget: { file: process.execPath, args: [process.execPath, process.execPath] },
    marker: {
      read: () => marker,
      write: (next) => {
        marker = next;
        calls.push(`marker.write ${next.status}`);
      },
      clear: () => {
        marker = null;
        calls.push('marker.clear');
      },
    },
    supervisor: {
      readRecord: () => control.supervisorRecord,
      getStaleModules: () => control.supervisorStale,
      requestReexec: (): SupervisorSignalResult => {
        calls.push('supervisor.reexec');
        return control.reexecResult;
      },
    },
  };
  const engine: UpdateEngine = createUpdateEngine(deps);

  /** Let work already in flight (a tap's immediate install attempt) run to its next wait. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** Advance the clock, firing every timer that comes due (each in order, with the clock at its due time). */
  async function advance(ms: number): Promise<void> {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.dueAt <= target).sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = Math.max(now, due.dueAt);
      due.callback();
      // Let the callback's async work (and what it chains) finish before the next timer.
      await settle();
    }
    now = target;
  }

  return {
    engine,
    posted,
    log,
    calls,
    state,
    control,
    advance,
    settle,
    getRecord: () => record,
    getLastRun: () => lastRun,
    getMarker: () => marker,
    setMarker: (next: UpdatePendingMarker | null) => {
      marker = next;
    },
    getTimerCount: () => timers.length,
    setNow: (value: number) => {
      now = value;
    },
    getNow: () => now,
    settings,
  };
}

/** Run the first scheduled check (10 minutes after the start). */
async function startAndCheck(harness: ReturnType<typeof createHarness>): Promise<void> {
  harness.engine.start();
  await harness.advance(firstCheckDelayMs);
}

const quiet: IdleVerdict = idle;

describe('npm: the hold and the idle wait', () => {
  test('first seen: no install before the 4 h hold ends; the screen says when', async () => {
    const harness = createHarness();
    harness.state.idleVerdict = quiet;
    await startAndCheck(harness);
    assert.deepEqual(harness.calls, ['npm.getLatest']);
    assert.equal(harness.getRecord().firstSeenAt?.['3.5.0'], startTime + firstCheckDelayMs);
    assert.deepEqual(harness.engine.getStatus().offer, {
      target: '3.5.0',
      action: 'waitHold',
      until: startTime + firstCheckDelayMs + npmHoldMs,
      required: null,
      skipReason: null,
      canInstallNow: true,
    });
    await harness.advance(npmHoldMs - checkIntervalMs);
    assert.equal(harness.calls.filter((call) => call.startsWith('npm.install')).length, 0, 'still held at the last check before the hold ends');
    assert.deepEqual(harness.posted, []);
  });

  test('hold over, a turn running: it waits; once the bot is idle it installs, self-checks, marks, and restarts in place', async () => {
    const harness = createHarness();
    await startAndCheck(harness);
    await harness.advance(npmHoldMs); // the first hourly check after the hold ends queues the install
    assert.equal(harness.engine.getStatus().phase, 'waitingForIdle');
    await harness.advance(idlePollIntervalMs * 5);
    assert.equal(harness.calls.filter((call) => call.startsWith('npm.install')).length, 0, 'a working agent holds the install back, however long');

    harness.state.idleVerdict = idle;
    await harness.advance(idlePollIntervalMs);
    const afterQueue = harness.calls.slice(harness.calls.indexOf('npm.install 3.5.0'));
    assert.deepEqual(afterQueue, ['npm.install 3.5.0', 'selfCheck 3.5.0', 'marker.write pending', 'lock.release', 'restart']);
    assert.deepEqual([harness.control.markerAtRestart?.from.version, harness.control.markerAtRestart?.to.version, harness.control.markerAtRestart?.attempts], ['3.4.0', '3.5.0', 0]);
  });

  test('«Update now» during the hold installs without waiting for it — and for a quiet period — but still waits for a running turn', async () => {
    const harness = createHarness();
    await startAndCheck(harness);
    assert.equal(await harness.engine.requestInstall('3.5.0'), 'started');
    assert.equal(harness.engine.getStatus().phase, 'waitingForIdle');
    assert.ok(harness.state.idleRequests.at(-1), 'the verdict is asked for as a user-requested install (no quiet period)');
    assert.equal(harness.calls.includes('npm.install 3.5.0'), false, 'a turn is running');
    harness.state.idleVerdict = idle;
    await harness.advance(idlePollIntervalMs);
    assert.ok(harness.calls.includes('npm.install 3.5.0'));
    assert.ok(harness.calls.includes('restart'));
  });

  test('a stale or unknown target is "already up to date"; nothing is queued', async () => {
    const harness = createHarness();
    await startAndCheck(harness);
    assert.equal(await harness.engine.requestInstall('9.9.9'), 'alreadyUpToDate');
    assert.equal(harness.engine.getStatus().phase, 'idle');
  });

  test('«Update now» works with the mode off too (it is a tap, not the schedule)', async () => {
    const harness = createHarness({ settings: { autoUpdate: 'off' } });
    harness.state.idleVerdict = idle;
    await harness.engine.checkNow();
    assert.equal(await harness.engine.requestInstall('3.5.0'), 'started');
    await harness.settle();
    assert.ok(harness.calls.includes('restart'));
  });
});

describe('npm: versions that are not installed', () => {
  test('a version deprecated during the hold is never installed and nothing is posted', async () => {
    const harness = createHarness();
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    harness.control.latest = { version: '3.5.0', engines: null, isDeprecated: true };
    await harness.advance(npmHoldMs);
    assert.equal(harness.calls.filter((call) => call.startsWith('npm.install')).length, 0);
    assert.deepEqual(harness.posted, []);
    assert.equal(harness.engine.getStatus().offer, null);
  });

  test('a major is offered once, after the hold, with the tap to install it; the tap installs', async () => {
    const harness = createHarness({ latest: { version: '4.0.0', engines: null, isDeprecated: false } });
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(npmHoldMs + checkIntervalMs * 2);
    assert.deepEqual(harness.posted, [{ kind: 'offerMajor', version: '4.0.0', running: '3.4.0' }]);
    assert.equal(harness.calls.filter((call) => call.startsWith('npm.install')).length, 0);
    assert.equal(harness.engine.getStatus().offer?.action, 'offerMajor');
    assert.equal(await harness.engine.requestInstall('4.0.0'), 'started');
    await harness.advance(idlePollIntervalMs);
    assert.ok(harness.calls.includes('npm.install 4.0.0'));
  });

  test('a Node that is too old: not installed, one message after the hold, and no tap to install', async () => {
    const harness = createHarness({ latest: { version: '3.5.0', engines: '>=24', isDeprecated: false } });
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(npmHoldMs + checkIntervalMs * 2);
    assert.deepEqual(harness.posted, [{ kind: 'needsNode', version: '3.5.0', required: '>=24', runningNode: '22.23.3' }]);
    assert.equal(harness.engine.getStatus().offer?.canInstallNow, false);
    assert.equal(await harness.engine.requestInstall('3.5.0'), 'blocked', 'there is an update, it cannot be installed here: not "up to date"');
  });

  test('the screen says what a version is at once, not after the hold: a Node that is too old (no tap), a major (a tap, never by itself)', async () => {
    const needsNode = createHarness({ latest: { version: '3.5.0', engines: '>=24', isDeprecated: false } });
    await startAndCheck(needsNode);
    assert.deepEqual(needsNode.engine.getStatus().offer, { target: '3.5.0', action: 'needsNode', until: null, required: '>=24', skipReason: null, canInstallNow: false });
    assert.deepEqual(needsNode.posted, [], 'the BOT still says nothing before the hold ends');

    const major = createHarness({ latest: { version: '4.0.0', engines: null, isDeprecated: false } });
    await startAndCheck(major);
    assert.deepEqual(major.engine.getStatus().offer, { target: '4.0.0', action: 'offerMajor', until: null, required: null, skipReason: null, canInstallNow: true });
    assert.deepEqual(major.posted, []);
  });

  test('a prefix that cannot be written: one notice per version after the hold, with the manual command; nothing installs', async () => {
    const readOnly: InstallKind = { kind: 'notifyOnly', reason: 'readOnlyPrefix', manualCommand: 'npm install -g charness@latest', isCheckout: false };
    const harness = createHarness({ installKind: readOnly });
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    assert.deepEqual(harness.posted, [], 'the notice waits for the hold too');
    await harness.advance(npmHoldMs + checkIntervalMs * 3);
    assert.deepEqual(harness.posted, [{ kind: 'notify', version: '3.5.0', running: '3.4.0', canInstall: false, manualCommand: 'npm install -g charness@latest' }]);
    assert.equal(harness.calls.filter((call) => call.startsWith('npm.install')).length, 0);
    assert.equal(await harness.engine.requestInstall('3.5.0'), 'cannotInstall');
  });

  test('notify mode: one message with the tap, nothing installs by itself; the tap installs', async () => {
    const harness = createHarness({ settings: { autoUpdate: 'notify' } });
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(npmHoldMs + checkIntervalMs * 2);
    assert.deepEqual(harness.posted, [{ kind: 'notify', version: '3.5.0', running: '3.4.0', canInstall: true, manualCommand: 'npm install -g charness@latest' }]);
    assert.equal(harness.calls.filter((call) => call.startsWith('npm.install')).length, 0);
    assert.equal(await harness.engine.requestInstall('3.5.0'), 'started');
  });

  test('off: the schedule makes no registry call at all; «Check now» does and posts nothing', async () => {
    const harness = createHarness({ settings: { autoUpdate: 'off' } });
    harness.engine.start();
    await harness.advance(checkIntervalMs * 5);
    assert.deepEqual(harness.calls, []);
    await harness.engine.checkNow();
    assert.deepEqual(harness.calls, ['npm.getLatest']);
    assert.deepEqual(harness.posted, []);
    assert.equal(harness.engine.getStatus().offer?.target, '3.5.0', 'the screen still shows what is out');
  });

  test('a manual check posts nothing even where a scheduled one would announce the version', async () => {
    const heldLongEnough = { firstSeenAt: { '3.5.0': startTime - npmHoldMs - 1 } };
    const manual = createHarness({ settings: { autoUpdate: 'notify' }, record: heldLongEnough });
    await manual.engine.checkNow();
    assert.deepEqual(manual.posted, []);
    const scheduled = createHarness({ settings: { autoUpdate: 'notify' }, record: heldLongEnough });
    await startAndCheck(scheduled);
    assert.equal(scheduled.posted.length, 1, 'the same state does announce on the schedule');
  });

  test('a hand edit to `on` takes effect at the next tick', async () => {
    const harness = createHarness({ settings: { autoUpdate: 'off' } });
    harness.engine.start();
    await harness.advance(checkIntervalMs * 2);
    assert.deepEqual(harness.calls, []);
    harness.settings.autoUpdate = 'on';
    await harness.advance(checkIntervalMs);
    assert.deepEqual(harness.calls, ['npm.getLatest']);
  });
});

describe('npm: an install that goes wrong', () => {
  async function installUntilIdle(harness: ReturnType<typeof createHarness>): Promise<void> {
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(npmHoldMs);
    await harness.advance(idlePollIntervalMs);
  }

  test('npm install fails: no restart, the target is remembered as failed, one line says so — and it is not retried', async () => {
    const harness = createHarness();
    harness.control.npmInstallError = new UpdateSourceError('npm install 3.5.0 failed: ENOSPC');
    await installUntilIdle(harness);
    assert.equal(harness.calls.includes('restart'), false);
    assert.equal(harness.getMarker(), null);
    assert.deepEqual(harness.getRecord().failedTargets, ['3.5.0']);
    assert.deepEqual(harness.posted, [{ kind: 'installFailed', target: '3.5.0', reason: 'install', stillRunning: '3.4.0', manualCommand: 'npm install -g charness@latest' }]);
    const installs = harness.calls.filter((call) => call.startsWith('npm.install')).length;
    await harness.advance(checkIntervalMs * 6);
    assert.equal(harness.calls.filter((call) => call.startsWith('npm.install')).length, installs, 'not retried by itself');
    assert.equal(harness.posted.length, 1);
    assert.equal(harness.engine.getStatus().phase, 'idle');
  });

  test('a newer version than the failed one is tried', async () => {
    const harness = createHarness();
    harness.control.npmInstallError = new UpdateSourceError('boom');
    await installUntilIdle(harness);
    harness.control.npmInstallError = null;
    harness.control.latest = { version: '3.5.1', engines: null, isDeprecated: false };
    await harness.advance(checkIntervalMs);
    await harness.advance(npmHoldMs);
    await harness.advance(idlePollIntervalMs * 2);
    assert.ok(harness.calls.includes('npm.install 3.5.1'));
  });

  test('«Update now» retries a failed version', async () => {
    const harness = createHarness();
    harness.control.npmInstallError = new UpdateSourceError('boom');
    await installUntilIdle(harness);
    harness.control.npmInstallError = null;
    assert.equal(await harness.engine.requestInstall('3.5.0'), 'alreadyUpToDate', 'the offer is gone while the version is failed');
  });

  test('a new version that fails its self-check is rolled back to the running one; one line, never retried', async () => {
    const harness = createHarness();
    harness.control.selfCheck = { ok: false, detail: 'node-pty does not load' };
    await installUntilIdle(harness);
    assert.deepEqual(harness.calls.filter((call) => call.startsWith('npm.install')), ['npm.install 3.5.0', 'npm.install 3.4.0 rollback']);
    assert.equal(harness.calls.includes('restart'), false);
    assert.deepEqual(harness.getRecord().failedTargets, ['3.5.0']);
    assert.deepEqual(harness.posted, [{ kind: 'installFailed', target: '3.5.0', reason: 'start', stillRunning: '3.4.0', manualCommand: 'npm install -g charness@latest' }]);
    assert.equal(harness.getMarker(), null);
  });

  test('a rollback that fails too says so (the message kind that is pinned)', async () => {
    const harness = createHarness();
    harness.control.selfCheck = { ok: false, detail: 'broken' };
    harness.control.npmRollbackError = new UpdateSourceError('npm install 3.4.0 failed: offline');
    await installUntilIdle(harness);
    assert.deepEqual(harness.posted, [{ kind: 'rollbackFailed', target: '3.5.0', reason: 'start', manualCommand: 'npm install -g charness@latest' }]);
  });

  test('the host lock is released whatever happens', async () => {
    const harness = createHarness();
    harness.control.npmInstallError = new UpdateSourceError('boom');
    await installUntilIdle(harness);
    assert.ok(harness.calls.includes('lock.release'));
  });
});

describe('two instances, one install, and a manual install', () => {
  test('the second instance does not install while the first holds the lock; it restarts onto the new version it finds on disk', async () => {
    const harness = createHarness();
    harness.control.lockHeld = true;
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(npmHoldMs);
    await harness.advance(idlePollIntervalMs * 2);
    assert.equal(harness.calls.filter((call) => call.startsWith('npm.install')).length, 0, 'no second install');
    assert.equal(harness.calls.includes('restart'), false);

    harness.state.installedVersion = '3.5.0'; // the other instance finished
    await harness.advance(idlePollIntervalMs * 2);
    assert.ok(harness.calls.includes('restart'));
    assert.equal(harness.control.markerAtRestart?.to.version, '3.5.0', 'its own "Updated" line follows: the restart carries the marker');
  });

  test('a manual `npm i -g` while running: the bot restarts onto it at its idle point, and not before', async () => {
    const harness = createHarness({ installedVersion: '3.5.0' });
    await harness.engine.runBootStep();
    assert.equal(harness.calls.includes('restart'), false);
    await harness.advance(idlePollIntervalMs * 3);
    assert.equal(harness.calls.includes('restart'), false, 'busy');
    harness.state.idleVerdict = idle;
    await harness.advance(idlePollIntervalMs);
    assert.deepEqual(harness.calls.filter((call) => call === 'restart' || call.startsWith('npm.install')), ['restart']);
    assert.ok(harness.calls.includes('selfCheck 3.5.0'), 'a newer install on disk is probed before the bot restarts onto it');
    assert.equal(harness.control.markerAtRestart?.status, 'pending');
  });

  test('a manual install is noticed at the next check — «Check now» or the hourly tick — even with the mode off', async () => {
    const manualCheck = createHarness({ settings: { autoUpdate: 'off' } });
    manualCheck.state.idleVerdict = idle;
    await manualCheck.engine.runBootStep();
    manualCheck.state.installedVersion = '3.5.0';
    await manualCheck.engine.checkNow();
    await manualCheck.advance(idlePollIntervalMs);
    assert.ok(manualCheck.calls.includes('restart'));

    const hourly = createHarness({ settings: { autoUpdate: 'off' } });
    hourly.state.idleVerdict = idle;
    hourly.engine.start();
    hourly.state.installedVersion = '3.5.0';
    await hourly.advance(firstCheckDelayMs);
    await hourly.advance(idlePollIntervalMs);
    assert.ok(hourly.calls.includes('restart'));
    assert.equal(hourly.calls.includes('npm.getLatest'), false, 'still no registry traffic with the mode off');
  });

  test('«Update now» for a version an operator already installed by hand: no second npm install — checked, marked, restarted onto at once', async () => {
    const harness = createHarness({ installedVersion: '3.5.0' });
    await harness.engine.checkNow();
    harness.state.idleVerdict = idle;
    assert.equal(await harness.engine.requestInstall('3.5.0'), 'started');
    await harness.settle();
    assert.deepEqual(harness.calls.filter((call) => call !== 'npm.getLatest' && call !== 'lock.release'), ['selfCheck 3.5.0', 'marker.write pending', 'restart']);
    assert.ok(harness.state.idleRequests.at(-1), 'a tap skips the quiet period');
  });

  test('a read-only prefix updated by hand is followed too', async () => {
    const readOnly: InstallKind = { kind: 'notifyOnly', reason: 'readOnlyPrefix', manualCommand: 'x', isCheckout: false };
    const harness = createHarness({ installKind: readOnly, installedVersion: '3.5.0' });
    harness.state.idleVerdict = idle;
    await harness.engine.runBootStep();
    await harness.advance(idlePollIntervalMs);
    assert.ok(harness.calls.includes('restart'));
  });

  test('a newer install on disk that fails its self-check is not restarted onto — logged once, not retried every poll', async () => {
    const harness = createHarness({ installedVersion: '3.5.0' });
    harness.control.selfCheck = { ok: false, detail: 'bot.js does not pass node --check' };
    harness.state.idleVerdict = idle;
    await harness.engine.runBootStep();
    await harness.advance(idlePollIntervalMs * 6);
    assert.equal(harness.calls.includes('restart'), false);
    assert.equal(harness.calls.filter((call) => call === 'selfCheck 3.5.0').length, 1);
    assert.match(harness.log.join('\n'), /fails its self-check, not restarting onto it: bot\.js does not pass node --check/);
    assert.equal(harness.getMarker(), null);
  });

  test('a restart that cannot be done is logged once and not tried again every poll', async () => {
    const harness = createHarness({ installedVersion: '3.5.0' });
    harness.control.restartError = new Error('no execve');
    harness.state.idleVerdict = idle;
    await harness.engine.runBootStep();
    await harness.advance(idlePollIntervalMs * 6);
    assert.equal(harness.calls.filter((call) => call === 'restart').length, 1);
    assert.match(harness.log.join('\n'), /restart failed: no execve/);
  });
});

describe('the boot step', () => {
  const lastRun: LastRunVersion = { version: '3.3.0', commit: null };

  function createPending(overrides: Partial<UpdatePendingMarker> = {}): UpdatePendingMarker {
    return { kind: 'npm', status: 'pending', from: lastRun, to: { version: '3.5.0', commit: null }, attempts: 1, isUserRequested: false, ...overrides };
  }

  test('after a self-update: "Updated X → Y" always, with the list under it; the range\'s Upgrading entries make it a to-do', async () => {
    const harness = createHarness({ running: { version: '3.5.0', commit: null }, lastRun, marker: createPending() });
    await harness.engine.runBootStep();
    assert.deepEqual(harness.posted, [
      {
        kind: 'updated',
        from: '3.3.0',
        to: '3.5.0',
        commitCount: null,
        summary: {
          todo: ['Rename the old variables.'],
          groups: [
            { version: '3.4.0', headlines: ['Old news.'] },
            { version: '3.5.0', headlines: ['A new board.'] },
          ],
          moreCount: 0,
        },
      },
    ]);
    assert.deepEqual(harness.getLastRun(), { version: '3.5.0', commit: null });
  });

  test('whatsNew off: the "Updated" line only', async () => {
    const harness = createHarness({ running: { version: '3.5.0', commit: null }, lastRun, marker: createPending(), settings: { whatsNew: false } });
    await harness.engine.runBootStep();
    assert.deepEqual(harness.posted, [{ kind: 'updated', from: '3.3.0', to: '3.5.0', commitCount: null, summary: null }]);
  });

  test('a version change nobody asked this bot for (a manual update): only the list, when whatsNew; nothing when it is off', async () => {
    const on = createHarness({ running: { version: '3.5.0', commit: null }, lastRun });
    await on.engine.runBootStep();
    assert.equal(on.posted.length, 1);
    assert.equal(on.posted[0].kind, 'nowRunning');
    const off = createHarness({ running: { version: '3.5.0', commit: null }, lastRun, settings: { whatsNew: false } });
    await off.engine.runBootStep();
    assert.deepEqual(off.posted, []);
  });

  test('an old package without a CHANGELOG, or without these versions: no list, not even an empty one', async () => {
    const none = createHarness({ running: { version: '3.5.0', commit: null }, lastRun, changelog: null });
    await none.engine.runBootStep();
    assert.deepEqual(none.posted, []);
    const bare = createHarness({ running: { version: '3.5.0', commit: null }, lastRun, marker: createPending(), changelog: null });
    await bare.engine.runBootStep();
    assert.deepEqual(bare.posted, [{ kind: 'updated', from: '3.3.0', to: '3.5.0', commitCount: null, summary: null }]);
  });

  test('the same version as last time: nothing is said, and the one-time announcement is not made again', async () => {
    const harness = createHarness({ running: { version: '3.4.0', commit: null }, lastRun: { version: '3.4.0', commit: null }, record: { isFeatureAnnounced: true } });
    await harness.engine.runBootStep();
    assert.deepEqual(harness.posted, []);
  });

  test('the very first run of the feature: the announcement, once — worded for the mode, never with the mode off', async () => {
    const on = createHarness();
    await on.engine.runBootStep();
    assert.deepEqual(on.posted, [{ kind: 'featureAnnounced', mode: 'on' }]);
    assert.equal(on.getRecord().isFeatureAnnounced, true);
    assert.deepEqual(on.getLastRun(), { version: '3.4.0', commit: null });
    await on.engine.runBootStep();
    assert.equal(on.posted.length, 1);
    const notify = createHarness({ settings: { autoUpdate: 'notify' } });
    await notify.engine.runBootStep();
    assert.deepEqual(notify.posted, [{ kind: 'featureAnnounced', mode: 'notify' }]);
    const off = createHarness({ settings: { autoUpdate: 'off' } });
    await off.engine.runBootStep();
    assert.deepEqual(off.posted, []);
  });

  test('a pending marker is confirmed after 60 s of running, not before', async () => {
    const harness = createHarness({ running: { version: '3.5.0', commit: null }, lastRun, marker: createPending() });
    await harness.engine.runBootStep();
    await harness.advance(bootConfirmMs - 1);
    assert.equal(harness.getMarker()?.status, 'pending');
    await harness.advance(1);
    assert.equal(harness.getMarker(), null);
  });

  test('a rolled-back update is reported by the restored version: the failure line, the target marked failed, the marker gone, no "Updated"', async () => {
    const harness = createHarness({
      running: { version: '3.4.0', commit: null },
      lastRun: { version: '3.4.0', commit: null },
      marker: createPending({ status: 'rolledBack', from: { version: '3.4.0', commit: null }, failureReason: 'the new version did not start' }),
      record: { isFeatureAnnounced: true },
    });
    await harness.engine.runBootStep();
    assert.deepEqual(harness.posted, [{ kind: 'installFailed', target: '3.5.0', reason: 'boot', stillRunning: '3.4.0', manualCommand: 'npm install -g charness@latest' }]);
    assert.deepEqual(harness.getRecord().failedTargets, ['3.5.0']);
    assert.equal(harness.getMarker(), null);
  });

  test('a rollback that failed is the pinned kind of message', async () => {
    const harness = createHarness({
      running: { version: '3.5.0', commit: null },
      lastRun: { version: '3.4.0', commit: null },
      marker: createPending({ status: 'rollbackFailed', from: { version: '3.4.0', commit: null }, failureReason: 'x' }),
      record: { isFeatureAnnounced: true },
    });
    await harness.engine.runBootStep();
    assert.deepEqual(harness.posted.map((message) => message.kind), ['rollbackFailed']);
  });
});

describe('a check that keeps failing', () => {
  test('one line on the first failure after a success — silence while it keeps failing, and again after a recovery', async () => {
    const harness = createHarness({ latest: { version: '3.4.0', engines: null, isDeprecated: false } });
    harness.engine.start();
    await harness.advance(firstCheckDelayMs);
    assert.deepEqual(harness.posted, []);
    harness.control.checkError = new UpdateSourceError('the registry did not answer');
    await harness.advance(checkIntervalMs * 3);
    assert.deepEqual(harness.posted, [{ kind: 'checkFailing', reason: 'the registry did not answer' }]);
    assert.equal(harness.engine.getStatus().isCheckFailing, true);
    assert.equal(harness.engine.getStatus().observation?.kind, 'error');
    harness.control.checkError = null;
    await harness.advance(checkIntervalMs);
    assert.equal(harness.engine.getStatus().isCheckFailing, false);
    harness.control.checkError = new UpdateSourceError('again');
    await harness.advance(checkIntervalMs);
    assert.equal(harness.posted.length, 2);
  });

  test('«Check now» that fails posts nothing to General', async () => {
    const harness = createHarness();
    harness.control.checkError = new UpdateSourceError('offline');
    const status = await harness.engine.checkNow();
    assert.deepEqual(harness.posted, []);
    assert.equal(status.isCheckFailing, true);
  });
});

describe('scheduling', () => {
  test('the first check comes 10 minutes after the start, then every hour', async () => {
    const harness = createHarness({ latest: { version: '3.4.0', engines: null, isDeprecated: false } });
    harness.engine.start();
    await harness.advance(firstCheckDelayMs - 1);
    assert.deepEqual(harness.calls, []);
    await harness.advance(1);
    assert.equal(harness.calls.length, 1);
    await harness.advance(checkIntervalMs);
    assert.equal(harness.calls.length, 2);
    await harness.advance(checkIntervalMs);
    assert.equal(harness.calls.length, 3);
  });

  test('restarts do not multiply checks: the last check time is persisted, the next one waits for it', async () => {
    const harness = createHarness({ latest: { version: '3.4.0', engines: null, isDeprecated: false }, record: { lastCheckAt: startTime - 20 * 60 * 1000 } });
    harness.engine.start();
    await harness.advance(firstCheckDelayMs);
    assert.deepEqual(harness.calls, [], 'checked 20 minutes ago: not again 10 minutes after this start');
    await harness.advance(checkIntervalMs - 20 * 60 * 1000 - firstCheckDelayMs);
    assert.equal(harness.calls.length, 1);
  });

  test('stop clears every timer', async () => {
    const harness = createHarness();
    harness.engine.start();
    await harness.engine.runBootStep();
    harness.engine.stop();
    assert.equal(harness.getTimerCount(), 0);
  });

  test('an npx run, or a checkout that cannot update itself, is never watched', async () => {
    const ephemeral = createHarness({ installKind: { kind: 'ephemeral' } });
    await startAndCheck(ephemeral);
    assert.deepEqual(ephemeral.calls, []);
    const readOnlyCheckout = createHarness({ installKind: { kind: 'notifyOnly', reason: 'readOnlyCheckout', manualCommand: 'x', isCheckout: true } });
    await startAndCheck(readOnlyCheckout);
    assert.deepEqual(readOnlyCheckout.calls, []);
  });
});

describe('a git checkout', () => {
  const behind: GitCheck = { status: 'behind', reason: null, from: 'a1b2c3d', to: 'd4e5f6a', behind: 12, migrationGuides: [] };
  const checkoutRunning: LastRunVersion = { version: '3.4.0', commit: 'a1b2c3d' };

  test('plain: behind → pulled at idle (the marker is written BEFORE the pull) → self-checked → restarted in place', async () => {
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: behind });
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(idlePollIntervalMs);
    assert.deepEqual(harness.calls.filter((call) => call !== 'git.check'), ['marker.write pending', 'git.apply hold', 'marker.write pending', 'selfCheck', 'restart']);
    assert.deepEqual([harness.control.markerAtRestart?.from.commit, harness.control.markerAtRestart?.to.commit], ['a1b2c3d', 'd4e5f6a']);
  });

  test('not idle: nothing is pulled — the idle gate is checked BEFORE pulling', async () => {
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: behind });
    await startAndCheck(harness);
    await harness.advance(idlePollIntervalMs * 4);
    assert.deepEqual(harness.calls, ['git.check']);
  });

  test('a commit that does not start: rolled back to the one that did, one line, not retried until upstream moves', async () => {
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: behind });
    harness.control.selfCheck = { ok: false, detail: 'does not compile' };
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(idlePollIntervalMs);
    assert.ok(harness.calls.includes('git.rollback a1b2c3d d4e5f6a'));
    assert.equal(harness.calls.includes('restart'), false);
    assert.deepEqual(harness.getRecord().failedTargets, ['d4e5f6a']);
    assert.deepEqual(harness.posted, [{ kind: 'installFailed', target: 'd4e5f6a', reason: 'start', stillRunning: 'a1b2c3d', manualCommand: '/srv/charness/scripts/self-update.sh' }]);
    const applies = harness.calls.filter((call) => call.startsWith('git.apply')).length;
    await harness.advance(checkIntervalMs * 4);
    assert.equal(harness.calls.filter((call) => call.startsWith('git.apply')).length, applies);
    harness.control.gitCheck = { ...behind, to: '1111111' };
    await harness.advance(checkIntervalMs);
    await harness.advance(idlePollIntervalMs);
    assert.equal(harness.calls.filter((call) => call.startsWith('git.apply')).length, applies + 1, 'a newer upstream commit is tried');
  });

  test('a build that fails after the pull: the checkout is put back on the commit that ran, one line, not retried', async () => {
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: behind });
    harness.control.gitApplyError = new UpdateSourceError('self-update.sh failed: yarn build: error TS2307');
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(idlePollIntervalMs);
    assert.ok(harness.calls.includes('git.rollback a1b2c3d d4e5f6a'), 'the script may have fast-forwarded before it failed');
    assert.equal(harness.calls.includes('restart'), false);
    assert.equal(harness.getMarker(), null);
    assert.deepEqual(harness.getRecord().failedTargets, ['d4e5f6a']);
    assert.deepEqual(harness.posted, [{ kind: 'installFailed', target: 'd4e5f6a', reason: 'install', stillRunning: 'a1b2c3d', manualCommand: '/srv/charness/scripts/self-update.sh' }]);
  });

  test('…and when even the way back fails, that is the pinned kind of message', async () => {
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: behind });
    harness.control.gitApplyError = new UpdateSourceError('boom');
    harness.control.gitRollbackError = new UpdateSourceError('git reset failed: local changes');
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(idlePollIntervalMs);
    assert.deepEqual(harness.posted.map((message) => message.kind), ['rollbackFailed']);
  });

  test('a range that adds a migration guide is offered once and not pulled; the tap pulls it', async () => {
    const guide: GitCheck = { ...behind, migrationGuides: ['MIGRATION_3_TO_4.md'] };
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: guide });
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(checkIntervalMs * 3);
    assert.deepEqual(harness.posted, [{ kind: 'offerBreaking', from: 'a1b2c3d', to: 'd4e5f6a', migrationGuides: ['MIGRATION_3_TO_4.md'] }]);
    assert.equal(harness.calls.some((call) => call.startsWith('git.apply')), false);
    assert.equal(await harness.engine.requestInstall('d4e5f6a'), 'started');
    await harness.advance(idlePollIntervalMs);
    assert.ok(harness.calls.includes('git.apply'), 'the tap allows the breaking range: no --hold-breaking');
  });

  test('a script that holds the range anyway (a guide appeared after the check) is offered, not merged', async () => {
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: behind });
    harness.control.gitApply = { status: 'held', from: 'a1b2c3d', to: 'd4e5f6a', migrationGuides: ['MIGRATION_X.md'] };
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(idlePollIntervalMs);
    assert.deepEqual(harness.posted, [{ kind: 'offerBreaking', from: 'a1b2c3d', to: 'd4e5f6a', migrationGuides: ['MIGRATION_X.md'] }]);
    assert.equal(harness.getMarker(), null);
    assert.equal(harness.calls.includes('restart'), false);
  });

  test('a checkout with local changes or ahead of upstream: nothing touched, nothing posted — the screen says why', async () => {
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: { status: 'skip', reason: 'dirty', from: '', to: '', behind: 0, migrationGuides: [] } });
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(checkIntervalMs * 3);
    assert.deepEqual(harness.posted, []);
    assert.equal(harness.calls.some((call) => call.startsWith('git.apply')), false);
    assert.equal(harness.engine.getStatus().offer?.action, 'skipped');
    assert.equal(harness.engine.getStatus().offer?.skipReason, 'dirty');
    assert.equal(await harness.engine.requestInstall(''), 'blocked', 'the checkout is behind and left alone — «update now» says that, not "up to date"');
    assert.equal(await harness.engine.requestInstall('d4e5f6a'), 'blocked', 'a stale button too');
    assert.equal(harness.calls.some((call) => call.startsWith('git.apply')), false, 'nothing was queued');
  });

  test('an unreachable remote is a failing check, not a skip', async () => {
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: { status: 'skip', reason: 'fetchFailed', from: '', to: '', behind: 0, migrationGuides: [] } });
    await startAndCheck(harness);
    assert.deepEqual(harness.posted, [{ kind: 'checkFailing', reason: 'the remote did not answer' }]);
  });

  test('after the update: "Updated a1b2c3d → d4e5f6a (12 commits)" with the entries the diff added', async () => {
    const harness = createHarness({
      installKind: checkout,
      running: { version: '3.4.0', commit: 'd4e5f6a' },
      lastRun: checkoutRunning,
      marker: { kind: 'git', status: 'pending', from: checkoutRunning, to: { version: '3.4.0', commit: 'd4e5f6a' }, attempts: 1, isUserRequested: false },
      record: { isFeatureAnnounced: true },
    });
    harness.control.changelogDiff = ['--- a/CHANGELOG.md', '+++ b/CHANGELOG.md', '@@ -1,3 +1,5 @@', ' ## Unreleased', ' ', '+**A new thing.** Details.', '+'].join('\n');
    await harness.engine.runBootStep();
    assert.deepEqual(harness.posted, [{ kind: 'updated', from: 'a1b2c3d', to: 'd4e5f6a', commitCount: 12, summary: { todo: [], groups: [{ version: null, headlines: ['A new thing.'] }], moreCount: 0 } }]);
  });

  async function pullInHotMode(configure: (control: ReturnType<typeof createHarness>['control']) => void): Promise<ReturnType<typeof createHarness>> {
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: behind, isHotMode: true });
    configure(harness.control);
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(idlePollIntervalMs);
    assert.ok(harness.calls.includes('git.apply hold'));
    return harness;
  }

  test('hot mode, a pull that changes no compiled source (docs, CHANGELOG, scripts, tests, manifests): the worker is asked to reload — the deadline is not left to take it for a failed build', async () => {
    for (const changedFiles of [['README.md'], ['CHANGELOG.md', 'src/__tests__/bot.test.ts'], ['scripts/self-update.sh', 'docker/entrypoint.sh'], ['yarn.lock', 'package.json'], ['src/release/cli.ts', 'src/types.d.ts']]) {
      const harness = await pullInHotMode((control) => {
        control.changedFiles = changedFiles;
      });
      assert.ok(harness.calls.includes('git.changedFiles a1b2c3d d4e5f6a'), changedFiles.join());
      assert.ok(harness.calls.includes('git.reloadHotWorker'), `nothing is rebuilt for ${changedFiles.join()}: the reload is requested`);
      assert.equal(harness.calls.includes('restart'), false, 'nodemon replaces the worker, this process does not restart itself');
    }
  });

  test('hot mode, a pull that changes a compiled source: tsc rebuilds and nodemon reloads by itself — no reload is requested', async () => {
    for (const changedFiles of [['src/bot.ts'], ['README.md', 'src/selfUpdate/updateEngine.ts'], ['src/types.ts']]) {
      const harness = await pullInHotMode((control) => {
        control.changedFiles = changedFiles;
      });
      assert.equal(harness.calls.includes('git.reloadHotWorker'), false, changedFiles.join());
    }
  });

  test('hot mode, a range that cannot be listed gets the reload too (a reload nobody needed is harmless, a rollback of a good pull is not); a reload that fails leaves the deadline as the safety net', async () => {
    const unreadable = await pullInHotMode((control) => {
      control.changedFilesError = new Error('git diff failed');
    });
    assert.ok(unreadable.calls.includes('git.reloadHotWorker'));

    const failing = await pullInHotMode((control) => {
      control.changedFiles = ['README.md'];
      control.reloadError = new Error('dist is missing');
    });
    assert.ok(failing.calls.includes('git.reloadHotWorker'));
    await failing.advance(hotBuildDeadlineMs);
    assert.ok(failing.calls.includes('git.rollback a1b2c3d d4e5f6a hot'), 'no new worker by the deadline: the existing safety net still rolls it back');
  });

  test('hot mode: the pull is not followed by a restart; a worker that never replaces this one by the build deadline is rolled back', async () => {
    const harness = createHarness({ installKind: checkout, running: checkoutRunning, gitCheck: behind, isHotMode: true });
    harness.state.idleVerdict = idle;
    await startAndCheck(harness);
    await harness.advance(idlePollIntervalMs);
    assert.ok(harness.calls.includes('git.apply hold'));
    assert.equal(harness.calls.includes('selfCheck'), false, 'dist is rebuilt by the watcher later: nothing to check yet');
    assert.equal(harness.calls.includes('restart'), false, 'nodemon replaces the worker by itself');
    await harness.advance(hotBuildDeadlineMs - 1);
    assert.equal(harness.calls.includes('restart'), false, 'still no restart of its own while it waits for the watcher');
    assert.equal(harness.calls.some((call) => call.startsWith('git.rollback')), false);
    await harness.advance(1);
    assert.ok(harness.calls.includes('git.rollback a1b2c3d d4e5f6a hot'));
    assert.deepEqual(harness.posted, [{ kind: 'installFailed', target: 'd4e5f6a', reason: 'build', stillRunning: 'a1b2c3d', manualCommand: '/srv/charness/scripts/self-update.sh' }]);
    assert.equal(harness.getMarker(), null);
    assert.deepEqual(harness.getRecord().failedTargets, ['d4e5f6a']);
  });
});

describe('the hot supervisor', () => {
  const record: HotSupervisorRecord = { pid: 10, startToken: 't', canReexec: true, modules: [] };

  test('a supervisor that loaded a file the update changed is asked to re-execute at the first idle moment, once', async () => {
    const harness = createHarness({ isHotMode: true, supervisorRecord: record, supervisorStale: ['cli/hot.js'], installKind: checkout, running: { version: '3.4.0', commit: 'a1b2c3d' }, lastRun: { version: '3.4.0', commit: 'a1b2c3d' }, record: { isFeatureAnnounced: true } });
    await harness.engine.runBootStep();
    await harness.advance(idlePollIntervalMs * 3);
    assert.equal(harness.calls.includes('supervisor.reexec'), false, 'busy');
    harness.state.idleVerdict = idle;
    await harness.advance(idlePollIntervalMs);
    assert.equal(harness.calls.filter((call) => call === 'supervisor.reexec').length, 1);
    await harness.advance(idlePollIntervalMs * 4);
    assert.equal(harness.calls.filter((call) => call === 'supervisor.reexec').length, 1);
  });

  const pendingBoot: UpdatePendingMarker = { kind: 'git', status: 'pending', from: { version: '3.4.0', commit: 'a1b2c3d' }, to: { version: '3.4.0', commit: 'd4e5f6a' }, attempts: 1, isUserRequested: false };

  test('the re-exec hands this boot back: it is not a failed start, so the update keeps its boots for real failures', async () => {
    const harness = createHarness({ isHotMode: true, supervisorRecord: record, supervisorStale: ['cli/hot.js'], installKind: checkout, running: { version: '3.4.0', commit: 'd4e5f6a' }, lastRun: { version: '3.4.0', commit: 'a1b2c3d' }, record: { isFeatureAnnounced: true }, marker: pendingBoot });
    harness.state.idleVerdict = idle;
    await harness.engine.runBootStep();
    await harness.advance(idlePollIntervalMs);
    assert.equal(harness.calls.filter((call) => call === 'supervisor.reexec').length, 1);
    assert.equal(harness.getMarker()?.attempts, 0);
    assert.equal(harness.getMarker()?.status, 'pending');
  });

  test('a re-exec that was not delivered (the supervisor is gone) hands nothing back', async () => {
    const harness = createHarness({ isHotMode: true, supervisorRecord: record, supervisorStale: ['cli/hot.js'], reexecResult: 'gone', installKind: checkout, running: { version: '3.4.0', commit: 'd4e5f6a' }, lastRun: { version: '3.4.0', commit: 'a1b2c3d' }, record: { isFeatureAnnounced: true }, marker: pendingBoot });
    harness.state.idleVerdict = idle;
    await harness.engine.runBootStep();
    await harness.advance(idlePollIntervalMs);
    assert.equal(harness.calls.filter((call) => call === 'supervisor.reexec').length, 1);
    assert.equal(harness.getMarker()?.attempts, 1);
  });

  test('a re-exec of a version that is already settled (no pending marker) touches no marker', async () => {
    const harness = createHarness({ isHotMode: true, supervisorRecord: record, supervisorStale: ['cli/hot.js'], installKind: checkout, running: { version: '3.4.0', commit: 'a1b2c3d' }, lastRun: { version: '3.4.0', commit: 'a1b2c3d' }, record: { isFeatureAnnounced: true } });
    harness.state.idleVerdict = idle;
    await harness.engine.runBootStep();
    await harness.advance(idlePollIntervalMs);
    assert.equal(harness.calls.filter((call) => call === 'supervisor.reexec').length, 1);
    assert.equal(harness.calls.some((call) => call.startsWith('marker.write')), false);
  });

  test('a supervisor whose files did not change is left alone', async () => {
    const harness = createHarness({ isHotMode: true, supervisorRecord: record, supervisorStale: [], installKind: checkout, running: { version: '3.4.0', commit: 'a1b2c3d' }, lastRun: { version: '3.4.0', commit: 'a1b2c3d' }, record: { isFeatureAnnounced: true } });
    harness.state.idleVerdict = idle;
    await harness.engine.runBootStep();
    await harness.advance(idlePollIntervalMs * 3);
    assert.equal(harness.calls.includes('supervisor.reexec'), false);
  });

  test('a supervisor that predates re-exec cannot be replaced: after a version change, one message says to restart it once', async () => {
    const harness = createHarness({ isHotMode: true, supervisorRecord: null, installKind: checkout, running: { version: '3.4.0', commit: 'd4e5f6a' }, lastRun: { version: '3.4.0', commit: 'a1b2c3d' }, record: { isFeatureAnnounced: true }, settings: { whatsNew: false } });
    await harness.engine.runBootStep();
    assert.deepEqual(harness.posted.map((message) => message.kind), ['restartSupervisor']);
    assert.equal(harness.calls.includes('supervisor.reexec'), false);
  });

  test('without a version change there is nothing to say about an old supervisor', async () => {
    const harness = createHarness({ isHotMode: true, supervisorRecord: null, installKind: checkout, running: { version: '3.4.0', commit: 'a1b2c3d' }, lastRun: { version: '3.4.0', commit: 'a1b2c3d' }, record: { isFeatureAnnounced: true } });
    await harness.engine.runBootStep();
    assert.deepEqual(harness.posted, []);
  });
});
