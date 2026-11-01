/**
 * @description The `/runners` render plan (`utils/runnersScreenPlan.ts`), pure: the list of machines (online with its hardware, jobs and
 * capabilities; offline as it was; paused), the buttons and their callback data (revisioned, within Telegram's 64 bytes, read back
 * exactly), the removal question, the address step with and without a proposal, the pairing message's parts and the two texts that
 * replace it. Texts are English (the plan takes `t`); every other locale is pinned by `i18n.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { t } from '../i18n';
import { parseProbeOutput, type RunnerProbe } from '../remoteRun/probe';
import type { PairedRunner } from '../runners/hubRegistry';
import {
  buildAddressStep,
  buildExpiredText,
  buildPairedText,
  buildPairingMessageParts,
  buildRemoveConfirmation,
  buildRunnerActionCallback,
  buildRunnersScreen,
  maxCallbackDataBytes,
  parseRunnersCallback,
  runnersAddressOtherCallback,
  runnersAddressUseCallback,
  runnersPairCallback,
  runnersRefreshCallback,
  type RunnerAction,
  type RunnerScreenEntry,
} from '../utils/runnersScreenPlan';

const formatTime = (epochMs: number): string => `T${epochMs}`;
const revision = 7;

function createRunner(overrides: Partial<PairedRunner> = {}): PairedRunner {
  return {
    id: '0123456789ab',
    name: 'mac',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOzzz',
    keyFingerprint: 'SHA256:abc',
    hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOyyy',
    workDir: '/Users/runner/.charness-runner/work',
    os: 'Darwin',
    arch: 'arm64',
    version: '3.8.0',
    serviceKind: 'system-service',
    pairedAtMs: 1_000,
    pairId: 'aaaaaaaaaaaa',
    label: '@ExampleBot',
    host: 'host.example',
    port: 22,
    isPaused: false,
    ...overrides,
  };
}

const probeText = [
  'os=Darwin', 'os_name=macOS', 'os_version=15.1', 'arch=arm64',
  'cpu_model=Apple M2 Pro', 'cpu_cores=12', 'cpu_threads=12', 'load=1.2',
  'ram_total_mb=32768', 'ram_free_mb=20480', 'disk_free_mb=215040',
  'pueue=4.0.4', 'jobs_running=1', 'jobs_queued=0', 'jobs_projects=1',
  'cap_android=yes', 'cap_android_detail=HVF, emulator',
  'cap_playwright=yes', 'cap_playwright_detail=chromium',
  'cap_ios=no', "cap_ios_detail=needs the runner user's login session",
  'cap_docker=no', 'cap_docker_detail=',
].join('\n');

function createEntry(overrides: Partial<RunnerScreenEntry> = {}): RunnerScreenEntry {
  return { runner: createRunner(), isOnline: true, lastSeenMs: 2_000, probe: parseProbeOutput(probeText), ...overrides };
}

describe('runnersScreenPlan: the list', () => {
  it('an online machine shows its system, how it is kept running, hardware, jobs and what it can do — what it can do first, what it cannot with why', () => {
    const screen = buildRunnersScreen({ revision, entries: [createEntry()], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.equal(
      screen.text,
      [
        'Runners — machines your agents can send tests and builds to',
        [
          'mac — online · macOS 15.1 (arm64) · always on (system service)',
          '  Apple M2 Pro, 12 cores, load 1.2 · RAM 32 GB, 20 GB free · disk 210 GB free',
          '  jobs: 1 running, 0 queued · projects: 1',
          "  can: android (HVF, emulator) · playwright (chromium) · ios: no — needs the runner user's login session · docker: no",
        ].join('\n'),
      ].join('\n\n'),
    );
  });

  it('an offline machine shows when it was last seen and its last snapshot, marked as old — no jobs, no capabilities, no load', () => {
    const entry = createEntry({ isOnline: false, lastSeenMs: 5_000, runner: createRunner({ name: 'box1', isPaused: true, serviceKind: 'user-service' }) });
    const { text } = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.includes('box1 — offline since T5000 · paused · macOS 15.1 (arm64) · user service\n'), text);
    assert.ok(text.includes('  as it was then: Apple M2 Pro, 12 cores · RAM 32 GB · disk 210 GB free'), text);
    assert.ok(!text.includes('jobs:') && !text.includes('can:') && !text.includes('load'), text);
  });

  it('a machine never seen says so, and with no snapshot only its heading shows (its registry facts stand in for the probe)', () => {
    const entry = createEntry({ isOnline: false, lastSeenMs: null, probe: null });
    const { text } = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.endsWith('mac — offline, never connected · Darwin (arm64) · always on (system service)'), text);
  });

  it('a missing Pueue is named beside the jobs, and a machine that reported no cores shows its threads', () => {
    const probe: RunnerProbe = { ...parseProbeOutput(probeText), pueueVersion: null, cpuCores: null, cpuThreads: 16, load: null };
    const { text } = buildRunnersScreen({ revision, entries: [createEntry({ probe })], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.includes('  Apple M2 Pro, 16 threads · RAM'), text);
    assert.ok(text.includes('projects: 1 · Pueue is missing on this runner'), text);
  });

  it('no machines: the empty text and only the pair and refresh buttons', () => {
    const screen = buildRunnersScreen({ revision, entries: [], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.equal(screen.text, 'Runners — machines your agents can send tests and builds to\n\nNo runners yet. A runner is any machine (Mac, Linux) your agents can send tests and builds to.');
    assert.deepEqual(screen.rows.map((row) => row.map((button) => button.text)), [['＋ Pair a new runner'], ['↻ Refresh']]);
    assert.deepEqual(screen.rows.map((row) => row.map((button) => button.data)), [[runnersPairCallback], [runnersRefreshCallback]]);
  });

  it('open pairing codes and a running check are said under the list', () => {
    const screen = buildRunnersScreen({ revision, entries: [], openPairingExpiries: [10, 20], isChecking: true }, t, formatTime);
    assert.ok(screen.text.endsWith('A pairing code is open until T10.\nA pairing code is open until T20.\n\n⏳ Checking the machines…'), screen.text);
  });

  it('every machine gets Pause (Resume when paused) and Remove, carrying the revision and its position', () => {
    const entries = [createEntry(), createEntry({ runner: createRunner({ id: 'ba9876543210', name: 'box1', isPaused: true }) })];
    const screen = buildRunnersScreen({ revision, entries, openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.deepEqual(screen.rows.map((row) => row.map((button) => button.text)), [
      ['＋ Pair a new runner'],
      ['mac: Pause', 'mac: Remove'],
      ['box1: Resume', 'box1: Remove'],
      ['↻ Refresh'],
    ]);
    assert.deepEqual(screen.rows.slice(1, 3).map((row) => row.map((button) => button.data)), [['rnr_7_0_p', 'rnr_7_0_x'], ['rnr_7_1_r', 'rnr_7_1_x']]);
  });
});

describe('runnersScreenPlan: callback data', () => {
  const actions: RunnerAction[] = ['pause', 'resume', 'remove', 'removeYes', 'removeNo'];

  it('reads back exactly what it built, for every action', () => {
    for (const action of actions) {
      assert.deepEqual(parseRunnersCallback(buildRunnerActionCallback(revision, 3, action)), { kind: 'runner', revision, index: 3, action });
    }
    assert.deepEqual(parseRunnersCallback(runnersPairCallback), { kind: 'pair' });
    assert.deepEqual(parseRunnersCallback(runnersRefreshCallback), { kind: 'refresh' });
    assert.deepEqual(parseRunnersCallback(runnersAddressUseCallback), { kind: 'addressUse' });
    assert.deepEqual(parseRunnersCallback(runnersAddressOtherCallback), { kind: 'addressOther' });
  });

  it('stays within Telegram\'s 64 bytes at the largest revision and position it could carry', () => {
    const hugeRevision = Number.MAX_SAFE_INTEGER;
    for (const action of actions) {
      assert.ok(Buffer.byteLength(buildRunnerActionCallback(hugeRevision, 99, action)) <= maxCallbackDataBytes, action);
    }
  });

  it('refuses data that is not one of its own', () => {
    for (const data of ['rnr_', 'rnr_x', 'rnr_7_0', 'rnr_7_0_z', 'rnr_7_-1_p', 'rnr_a_0_p', 'rnr_7_0_p_extra', 'fbk_add', 'tka_5', '']) {
      assert.equal(parseRunnersCallback(data), null, data);
    }
  });

  it('every button of every screen fits the cap', () => {
    const entries = Array.from({ length: 12 }, (_value, index) => createEntry({ runner: createRunner({ id: index.toString(16).padStart(12, '0'), name: `box-${index}` }) }));
    const screens = [
      buildRunnersScreen({ revision: 1_000_000, entries, openPairingExpiries: [], isChecking: false }, t, formatTime),
      buildRemoveConfirmation('box-3', 1_000_000, 3, t),
      buildAddressStep('203.0.113.5:22', t),
      buildAddressStep(null, t),
    ];
    for (const screen of screens) {
      for (const button of screen.rows.flat()) assert.ok(Buffer.byteLength(button.data) <= maxCallbackDataBytes, button.data);
    }
  });
});

describe('runnersScreenPlan: the other screens and texts', () => {
  it('the removal question names the machine and what happens, with Remove and Cancel acting on the same revision and position', () => {
    const question = buildRemoveConfirmation('mac', revision, 0, t);
    assert.equal(question.text, 'Remove mac? Its key is deleted and it stops connecting. Jobs running there are killed.');
    assert.deepEqual(question.rows.map((row) => row.map((button) => [button.text, button.data])), [[['Remove', 'rnr_7_0_xy'], ['Cancel', 'rnr_7_0_xn']]]);
  });

  it('the address step with a proposal offers it and "another"; without one only "another", and says none was found', () => {
    const withProposal = buildAddressStep('203.0.113.5:22', t);
    assert.equal(
      withProposal.text,
      'Runners connect to this machine over ssh (outbound from the runner, nothing to open there).\n\n' +
        "Address runners will dial: 203.0.113.5:22 — found on this machine, answers with this machine's ssh key ✓",
    );
    assert.deepEqual(withProposal.rows.map((row) => row.map((button) => [button.text, button.data])), [
      [['Use 203.0.113.5:22', runnersAddressUseCallback], ['Enter another address', runnersAddressOtherCallback]],
    ]);

    const without = buildAddressStep(null, t);
    assert.ok(without.text.includes('No public address of this machine was found.'), without.text);
    assert.deepEqual(without.rows.map((row) => row.map((button) => button.data)), [[runnersAddressOtherCallback]]);
  });

  it('the pairing message is an intro and an outro around the line: the lifetime, the account to use, the warning', () => {
    const parts = buildPairingMessageParts(10, t);
    assert.equal(
      parts.intro,
      "Pair a runner — valid 10 minutes, single use.\n\nRun this on the runner machine, as the account that will run jobs\n(not your main account — it runs the agents' code):",
    );
    assert.equal(parts.outro, 'Anyone with this line can attach a machine to this charness until it is used or expires.');
  });

  it('what the pairing message becomes: paired (with the name and the time) or expired', () => {
    assert.equal(buildPairedText('mac', 42, t, formatTime), 'Runner “mac” paired T42.');
    assert.equal(buildExpiredText(t), 'Pairing code expired.');
  });
});
