/**
 * @description The `/runners` render plan (`utils/runnersScreenPlan.ts`), pure: the list of machines (online with its hardware, jobs and
 * capabilities; offline as it was; paused), the buttons and their callback data (revisioned, within Telegram's 64 bytes, read back
 * exactly), the removal question, the address step with and without a proposal, the pairing message's parts and the two texts that
 * replace it. Texts are English (the plan takes `t`); every other locale is pinned by `i18n.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localeCodes, runWithLocale, t } from '../i18n';
import { parseProbeOutput, type RunnerProbe } from '../remoteRun/probe';
import type { PairedRunner } from '../runners/hubRegistry';
import { buildAdminBootstrapLine, buildBootstrapLine, defaultRunnerAccount } from '../runners/bootstrapLine';
import { unconfirmedRemovalStopAfterHours } from '../runners/removalTiming';
import { createPairCodePayload } from './runnersTestKit';
import {
  buildRunnersPageCallback,
  buildAddressStep,
  buildClosedText,
  buildExpiredText,
  buildPairedText,
  buildPairingMessageParts,
  buildRemovalOutcomeText,
  buildServiceRemovalText,
  buildRemoveConfirmation,
  buildRunnerActionCallback,
  buildRunnersScreen,
  buildSeeFirstMessageText,
  clipReportedText,
  maxCallbackDataBytes,
  maxReportedTextChars,
  maxScreenTextChars,
  paginateBlocks,
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

describe('runnersScreenPlan: what is told after removing an always-on service', () => {
  const commands = ['sudo launchctl bootout system/com.charness.runner.0a1b2c3d', 'sudo rm /Library/LaunchDaemons/com.charness.runner.0a1b2c3d.plist'];

  it('says that the service keeps running until an admin there removes it, gives the commands one per line and says where they come from', () => {
    assert.equal(
      buildServiceRemovalText('mac', commands, t),
      `⚠️ mac runs as an always-on service on that machine, and only an admin there can stop it (nothing of charness runs as root). It keeps running until then. As an admin on that machine, run:\n${commands.join('\n')}\nThese commands come from this charness host, not from the machine itself.`,
    );
  });

  it('in every language names the machine, carries every command whole and leaves no placeholder behind', () => {
    const english = buildServiceRemovalText('mac', commands, t);
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const text = buildServiceRemovalText('mac', commands, t);
        assert.ok(text.includes('mac'), `${locale}: the machine`);
        for (const command of commands) assert.ok(text.split('\n').includes(command), `${locale}: «${command}» on a line of its own`);
        assert.doesNotMatch(text, /\{[a-z]+\}/, `${locale}: no placeholder is left`);
        assert.ok(text.length < 1500, `${locale}: ${text.length} characters`);
        if (locale !== 'en') assert.notEqual(text, english, `${locale}: translated, not the English fallback`);
      });
    }
  });
});

describe('runnersScreenPlan: where a machine\'s link comes from', () => {
  const screenOf = (entry: RunnerScreenEntry): string => buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text;

  it('a machine whose link came from another address says so under its block: where from now, where from before, when', () => {
    const text = screenOf(createEntry({ linkConcern: { kind: 'sourceChanged', fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: 7_000, isLiveReplacement: false } }));
    assert.ok(text.endsWith('\n  ⚠️ Its link now comes from 203.0.113.9 (it came from 198.51.100.7 before, T7000).'), text);
  });

  it('a link that took the place of one still up says what to do', () => {
    const text = screenOf(createEntry({ linkConcern: { kind: 'sourceChanged', fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: 7_000, isLiveReplacement: true } }));
    assert.match(text, /\n  ⚠️ A link from 203\.0\.113\.9 took over while the one from 198\.51\.100\.7 was still up \(T7000\)\. If that is not you changing networks, remove this runner and pair it again: its key may be in use elsewhere\.$/);
  });

  it('links that fight say so, with the addresses and the count', () => {
    const text = screenOf(createEntry({ linkConcern: { kind: 'fighting', sources: ['198.51.100.7', '203.0.113.9'], changeCount: 3, atMs: 7_000 } }));
    assert.match(text, /\n  ⚠️ Links from 198\.51\.100\.7, 203\.0\.113\.9 keep replacing each other \(3 switches in 10 minutes\)\. Two machines may be using this runner’s key: remove it and pair it again if that is not intended\.$/);
  });

  it('also under a machine that was never probed (a line of its own after the heading), and nothing without a concern', () => {
    assert.ok(screenOf(createEntry({ probe: null, linkConcern: { kind: 'fighting', sources: ['a', 'b'], changeCount: 3, atMs: 7_000 } })).includes('\n  ⚠️ Links from a, b keep replacing'));
    assert.ok(!screenOf(createEntry({ linkConcern: null })).includes('⚠️'));
    assert.ok(!screenOf(createEntry()).includes('⚠️'));
  });

  it('in every language the three notes name every address and time they are given, and leave no placeholder behind', () => {
    const concerns = [
      { kind: 'sourceChanged' as const, fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: 7_000, isLiveReplacement: false },
      { kind: 'sourceChanged' as const, fromSource: '198.51.100.7', toSource: '203.0.113.9', atMs: 7_000, isLiveReplacement: true },
      { kind: 'fighting' as const, sources: ['198.51.100.7', '203.0.113.9'], changeCount: 3, atMs: 7_000 },
    ];
    const lastLineOf = (concern: (typeof concerns)[number]): string => screenOf(createEntry({ linkConcern: concern })).split('\n').at(-1) ?? '';
    const english = runWithLocale('en', () => concerns.map(lastLineOf));
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        concerns.forEach((concern, index) => {
          const line = lastLineOf(concern);
          assert.ok(line.includes('203.0.113.9') && line.includes('198.51.100.7'), `${locale}: ${line}`);
          assert.doesNotMatch(line, /\{[a-z]+\}/, `${locale}: no placeholder is left`);
          if (concern.kind === 'fighting') assert.ok(line.includes('3'), `${locale}: the count`);
          else assert.ok(line.includes('T7000'), `${locale}: the time`);
          if (locale !== 'en') assert.notEqual(line, english[index], `${locale}: translated, not the English fallback`);
        });
      });
    }
  });
});

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

  it('the Node and yarn the jobs run with are one line under what it can do — a version, «none» or «gave no answer»; nothing when its script did not report them', () => {
    const withTools = (tools: string[]): RunnerScreenEntry => createEntry({ probe: parseProbeOutput([probeText, ...tools].join('\n')) });
    const lineOf = (entry: RunnerScreenEntry): string | undefined => buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text.split('\n').find((line) => line.includes('jobs run with'));
    assert.equal(lineOf(withTools(['job_node=v24.22.2', 'job_yarn=1.22.22'])), '  jobs run with: Node v24.22.2 · yarn 1.22.22');
    assert.equal(lineOf(withTools(['job_node=v24.22.2', 'job_yarn=none'])), '  jobs run with: Node v24.22.2 · yarn none (a job that calls it fails)');
    assert.equal(lineOf(withTools(['job_node=none', 'job_yarn=unknown'])), '  jobs run with: Node none (a job that calls it fails) · yarn there, but gave no answer');
    assert.equal(lineOf(createEntry()), undefined);
    const offline = withTools(['job_node=v24.22.2', 'job_yarn=1.22.22']);
    assert.equal(lineOf({ ...offline, isOnline: false }), undefined, 'a machine that is offline shows no live tools');
  });

  it('how the link keeps the machine awake is one line under the tools — yes with how, or NO with why; nothing when the runner did not say, and a reason it reported is clipped', () => {
    const withAwake = (lines: string[]): RunnerScreenEntry => createEntry({ probe: parseProbeOutput([probeText, ...lines].join('\n')) });
    const lineOf = (entry: RunnerScreenEntry): string | undefined => buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text.split('\n').find((line) => line.includes('keeps awake'));
    assert.equal(lineOf(withAwake(['awake=caffeinate'])), '  keeps awake: yes (caffeinate; a closed lid still sleeps it)');
    assert.equal(lineOf(withAwake(['awake=systemd-inhibit'])), '  keeps awake: yes (systemd-inhibit; a closed lid still sleeps it)');
    assert.equal(lineOf(withAwake(['awake=no', 'awake_detail=systemd-inhibit was not found'])), '  keeps awake: NO — systemd-inhibit was not found; it may sleep when idle');
    assert.equal(lineOf(withAwake(['awake=no'])), '  keeps awake: NO — no reason given; it may sleep when idle');
    assert.equal(lineOf(createEntry()), undefined);
    assert.ok((lineOf(withAwake(['awake=no', `awake_detail=${'x'.repeat(2000)}`])) ?? '').length < 400, 'a reason the machine reported is clipped');
    assert.equal(lineOf({ ...withAwake(['awake=caffeinate']), isOnline: false }), undefined, 'an offline machine shows no live state');
  });

  it('in every language the awake line says how and leaves no placeholder behind', () => {
    const entry = createEntry({ probe: parseProbeOutput([probeText, 'awake=no', 'awake_detail=SOMETHING-REPORTED'].join('\n')) });
    const yes = createEntry({ probe: parseProbeOutput([probeText, 'awake=caffeinate'].join('\n')) });
    const english = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const text = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
        assert.ok(text.includes('SOMETHING-REPORTED'), `${locale}: the reason`);
        assert.doesNotMatch(text, /\{[a-zA-Z]+\}/, `${locale}: no placeholder is left`);
        const yesText = buildRunnersScreen({ revision, entries: [yes], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
        assert.ok(yesText.includes('caffeinate'), `${locale}: the method`);
        assert.doesNotMatch(yesText, /\{[a-zA-Z]+\}/, `${locale}: no placeholder is left (yes)`);
        if (locale !== 'en') assert.notEqual(text, english, `${locale}: translated, not the English fallback`);
      });
    }
  });

  it('in every language the line names both versions and leaves no placeholder behind', () => {
    const entry = createEntry({ probe: parseProbeOutput([probeText, 'job_node=v24.22.2', 'job_yarn=none'].join('\n')) });
    const english = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const text = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text;
        const line = text.split('\n').find((candidate) => candidate.includes('v24.22.2'));
        assert.ok(line !== undefined && line.includes('Node') && line.includes('yarn'), `${locale}: ${line}`);
        assert.doesNotMatch(text, /\{[a-zA-Z]+\}/, `${locale}: no placeholder is left`);
        if (locale !== 'en') assert.notEqual(text, english, `${locale}: translated, not the English fallback`);
      });
    }
  });

  it('a machine online with its Mac\'s lid closed says so where it says «online» and shows its last snapshot as an old one — no jobs, no capabilities, no load: it was not asked', () => {
    const entry = createEntry({ isLidClosed: true });
    const { text } = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.includes('mac — lid closed — takes no new jobs · macOS 15.1 (arm64) · always on (system service)\n'), text);
    assert.ok(text.includes('  as it was then: Apple M2 Pro, 12 cores · RAM 32 GB · disk 210 GB free'), text);
    assert.ok(!text.includes('jobs:') && !text.includes('can:') && !text.includes('load') && !text.includes('— online'), text);
  });

  it('a lid-closed machine keeps its Pause and Remove buttons: the lid is not a state the operator sets', () => {
    const screen = buildRunnersScreen({ revision, entries: [createEntry({ isLidClosed: true })], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.deepEqual(screen.rows[1].map((button) => button.text), ['mac: Pause', 'mac: Remove']);
  });

  it('in every language the lid-closed status is its own words, not the English ones and not the online word', () => {
    const english = t('runners.statusLidClosed');
    for (const code of localeCodes) {
      runWithLocale(code, () => {
        const text = t('runners.statusLidClosed');
        assert.notEqual(text, '', code);
        assert.notEqual(text, t('runners.statusOnline'), code);
        if (code !== 'en') assert.notEqual(text, english, code);
        const { text: screen } = buildRunnersScreen({ revision, entries: [createEntry({ isLidClosed: true })], openPairingExpiries: [], isChecking: false }, t, formatTime);
        assert.ok(screen.includes(`mac — ${text} · `), `${code}: ${screen}`);
      });
    }
  });

  it('an offline machine shows when it was last seen and its last snapshot, marked as old — no jobs, no capabilities, no load', () => {
    const entry = createEntry({ isOnline: false, lastSeenMs: 5_000, runner: createRunner({ name: 'box1', isPaused: true, serviceKind: 'user-service' }) });
    const { text } = buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.includes('box1 — offline since T5000 · paused · macOS 15.1 (arm64) · user service\n'), text);
    assert.ok(text.includes('  as it was then: Apple M2 Pro, 12 cores · RAM 32 GB · disk 210 GB free'), text);
    assert.ok(!text.includes('jobs:') && !text.includes('can:') && !text.includes('load'), text);
  });

  it('how a machine is kept running is what its probe says NOW, not the registry\'s word from the day it was paired (\"run by hand\" until `service install`)', () => {
    const installedLater = createEntry({ runner: createRunner({ serviceKind: 'foreground' }), probe: parseProbeOutput(`${probeText}\nservice=user-service`) });
    const { text } = buildRunnersScreen({ revision, entries: [installedLater], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.ok(text.includes('mac — online · macOS 15.1 (arm64) · user service\n'), text);
    assert.ok(!text.includes('run by hand'), text);
    const lastSeen = createEntry({ isOnline: false, lastSeenMs: 5_000, runner: createRunner({ serviceKind: 'foreground' }), probe: parseProbeOutput(`${probeText}\nservice=system-service`) });
    assert.ok(buildRunnersScreen({ revision, entries: [lastSeen], openPairingExpiries: [], isChecking: false }, t, formatTime).text.includes('mac — offline since T5000 · macOS 15.1 (arm64) · always on (system service)\n'));
  });

  it('a probe that says nothing about it (no `service=` line: an older runner script) leaves the registry\'s word standing', () => {
    const entry = createEntry({ runner: createRunner({ serviceKind: 'user-service' }), probe: parseProbeOutput(probeText) });
    assert.ok(buildRunnersScreen({ revision, entries: [entry], openPairingExpiries: [], isChecking: false }, t, formatTime).text.includes('mac — online · macOS 15.1 (arm64) · user service\n'));
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

  it('an open pairing code and a running check are said under the list; several codes are ONE line with their count and the last expiry', () => {
    const one = buildRunnersScreen({ revision, entries: [], openPairingExpiries: [10], isChecking: true }, t, formatTime);
    assert.ok(one.text.endsWith('A pairing code is open until T10.\n\n⏳ Checking the machines…'), one.text);
    const several = buildRunnersScreen({ revision, entries: [], openPairingExpiries: [10, 30, 20, 5, 7, 9, 11, 13], isChecking: false }, t, formatTime);
    assert.ok(several.text.endsWith('8 pairing codes are open, the last until T30.'), several.text);
    assert.equal(several.text.split('\n').filter((line) => line.includes('pairing code')).length, 1);
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
    for (const page of [0, 1, 17]) assert.deepEqual(parseRunnersCallback(buildRunnersPageCallback(page)), { kind: 'page', page });
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
    assert.ok(Buffer.byteLength(buildRunnersPageCallback(Number.MAX_SAFE_INTEGER)) <= maxCallbackDataBytes);
  });

  it('refuses data that is not one of its own', () => {
    for (const data of ['rnr_', 'rnr_x', 'rnr_7_0', 'rnr_7_0_z', 'rnr_7_-1_p', 'rnr_a_0_p', 'rnr_7_0_p_extra', 'rnr_pg_', 'rnr_pg_x', 'rnr_pg_-1', 'rnr_pg_1_2', 'fbk_add', 'tka_5', '']) {
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

  it('the pairing is two messages: the admin line\'s intro (lifetime, the account that is the last word), the plain line\'s intro and the outro (what the account must be, who can use a line)', () => {
    const parts = buildPairingMessageParts(10, 'runner', t);
    assert.equal(
      parts.adminIntro,
      'Pair a runner — valid 10 minutes, single use.\n\n① From an admin account of the runner machine: pairs «runner» (the last word — change it if needed) and keeps it running. Runs code from this charness host as root on that machine:',
    );
    assert.equal(parts.alternativeIntro, '② Without admin rights: run this one in the terminal of the runner account itself:');
    assert.equal(
      parts.alternativeOutro,
      "The account must be an existing standard user, not your main account — it runs the agents' code. Anyone with either line can attach a machine to this charness until one of them is used or expires.",
    );
    assert.ok(buildPairingMessageParts(10, 'ci-runner', t).adminIntro.includes('«ci-runner»'), 'the account is named as given');
  });

  it('the pointer a second pairing message becomes when Telegram will not delete it is told in every language — its own words, no placeholder, a short line', () => {
    const english = buildSeeFirstMessageText(t);
    for (const locale of localeCodes) {
      const text = runWithLocale(locale, () => buildSeeFirstMessageText(t));
      assert.ok(text.length > 10 && text.length < 120, `${locale}: «${text}»`);
      assert.doesNotMatch(text, /\{[a-z]+\}/, `${locale}: no placeholder is left`);
      if (locale !== 'en') assert.notEqual(text, english, `${locale}: translated, not the English fallback`);
    }
  });

  it('in every language each pairing message — its text and its line — fits a Telegram message (4096 characters) with room for a long address', () => {
    // A 29-character host and a 15-character hub account: longer than a typical address.
    const payload = createPairCodePayload({ host: 'a-quite-long-name.example.com', user: 'a-hub-user-name' });
    const adminLine = buildAdminBootstrapLine(payload);
    const plainLine = buildBootstrapLine(payload);
    const roomToSpare = 100;
    for (const locale of localeCodes) {
      runWithLocale(locale, () => {
        const parts = buildPairingMessageParts(10, defaultRunnerAccount, t);
        const adminLength = `${parts.adminIntro}\n\n${adminLine}`.length;
        const plainLength = `${parts.alternativeIntro}\n\n${plainLine}\n\n${parts.alternativeOutro}`.length;
        assert.ok(adminLength < 4096 - roomToSpare, `${locale}: the admin message is ${adminLength} characters`);
        assert.ok(plainLength < 4096 - roomToSpare, `${locale}: the plain message is ${plainLength} characters`);
        assert.ok(parts.adminIntro.includes(`${defaultRunnerAccount}`), `${locale}: the account is named`);
        // The admin line gives the charness host root on that machine for the paste: the message says so in every language (the plain line does not).
        assert.ok(parts.adminIntro.includes('root') && parts.adminIntro.includes('charness'), `${locale}: the admin intro names the trust it gives`);
        assert.ok(!parts.alternativeIntro.includes('root'), `${locale}: the plain line gives no such trust`);
      });
    }
  });

  it('what the pairing message becomes: paired (with the name and the time) or expired', () => {
    assert.equal(buildPairedText('mac', 42, t, formatTime), 'Runner “mac” paired T42.');
    assert.equal(buildExpiredText(t), 'Pairing code expired.');
    assert.equal(buildClosedText(t), 'This line was used on a machine that was already paired — nothing new was paired.');
    assert.equal(buildSeeFirstMessageText(t), 'The code of this line is settled — see the message above for the result.');
  });
});

describe('runnersScreenPlan: a bounded, paged list', () => {
  /** A machine whose report is as bulky as a machine can make it: every string a machine reports is 500 characters long. */
  function createBulkyEntry(index: number, overrides: Partial<RunnerScreenEntry> = {}): RunnerScreenEntry {
    const long = 'x'.repeat(500);
    const probe = parseProbeOutput(`${probeText}\ncpu_model=${long}\ncap_android_detail=${long}\ncap_ios_detail=${long}\ncap_docker=yes\ncap_docker_detail=${long}\ncap_playwright_detail=${long}\nos_name=${long}`);
    return createEntry({ runner: createRunner({ id: index.toString(16).padStart(12, '0'), name: `box-${index}` }), probe, ...overrides });
  }

  it('clips what a machine reported to a fixed length, with an ellipsis, and leaves a short text alone', () => {
    assert.equal(clipReportedText('short'), 'short');
    assert.equal(clipReportedText('y'.repeat(maxReportedTextChars)), 'y'.repeat(maxReportedTextChars));
    const clipped = clipReportedText('y'.repeat(maxReportedTextChars + 1));
    assert.equal(clipped.length, maxReportedTextChars);
    assert.ok(clipped.endsWith('…'));
  });

  it('paginateBlocks fills a page while the text fits, always gives a block a page of its own at least, and covers every block once', () => {
    const blocks = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100), 'd'.repeat(100)];
    assert.deepEqual(paginateBlocks(blocks, 1000), [{ start: 0, end: 4 }]);
    // Two blocks and their blank-line separator are 202 characters.
    assert.deepEqual(paginateBlocks(blocks, 202), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    assert.deepEqual(paginateBlocks(blocks, 201), [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }]);
    assert.deepEqual(paginateBlocks(blocks, 5), [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }], 'a block over the budget still has a page');
    assert.deepEqual(paginateBlocks([], 100), []);
  });

  it('a list that fits is one page with no navigation and no page line', () => {
    const screen = buildRunnersScreen({ revision, entries: [createEntry(), createEntry({ runner: createRunner({ id: 'ba9876543210', name: 'box1' }) })], openPairingExpiries: [], isChecking: false }, t, formatTime);
    assert.equal(screen.pageCount, 1);
    assert.equal(screen.page, 0);
    assert.ok(!screen.text.includes('Page '), screen.text);
    assert.ok(!screen.rows.flat().some((button) => button.data.startsWith('rnr_pg_')));
  });

  it('thirty machines with the bulkiest reports fit pages that each stay within the screen budget AND Telegram\'s 4096, and every machine is on exactly one page, in order', () => {
    const entries = Array.from({ length: 30 }, (_value, index) => createBulkyEntry(index));
    const model = { revision, entries, openPairingExpiries: [1, 2, 3, 4, 5, 6, 7, 8], isChecking: true };
    const first = buildRunnersScreen(model, t, formatTime);
    assert.ok(first.pageCount > 4, `${first.pageCount} pages`);
    const seen: string[] = [];
    for (let page = 0; page < first.pageCount; page += 1) {
      const screen = buildRunnersScreen(model, t, formatTime, page);
      assert.equal(screen.page, page);
      assert.ok(screen.text.length <= maxScreenTextChars, `page ${page + 1}: ${screen.text.length} characters`);
      assert.ok(screen.text.length <= 4096);
      assert.ok(screen.text.includes(`Page ${page + 1} of ${first.pageCount}`));
      seen.push(...[...screen.text.matchAll(/^(box-\d+) — /gm)].map((match) => match[1]));
      for (const button of screen.rows.flat()) assert.ok(Buffer.byteLength(button.data) <= maxCallbackDataBytes, button.data);
      assert.ok(screen.rows.length <= 100, 'within the keyboard limit');
    }
    assert.deepEqual(seen, entries.map((entry) => entry.runner.name));
  });

  it('a machine\'s buttons keep its place in the WHOLE list and the revision, whichever page it is on', () => {
    const entries = Array.from({ length: 30 }, (_value, index) => createBulkyEntry(index));
    const model = { revision: 42, entries, openPairingExpiries: [], isChecking: false };
    const pageCount = buildRunnersScreen(model, t, formatTime).pageCount;
    const buttonData: string[] = [];
    for (let page = 0; page < pageCount; page += 1) {
      const screen = buildRunnersScreen(model, t, formatTime, page);
      buttonData.push(...screen.rows.flat().map((button) => button.data).filter((data) => data.endsWith('_p')));
    }
    assert.deepEqual(buttonData, entries.map((_entry, index) => `rnr_42_${index}_p`));
  });

  it('Previous and Next appear only where there is a page to go to, and a page past either end is clamped', () => {
    const entries = Array.from({ length: 30 }, (_value, index) => createBulkyEntry(index));
    const model = { revision, entries, openPairingExpiries: [], isChecking: false };
    const { pageCount } = buildRunnersScreen(model, t, formatTime);
    const labelsOf = (page: number): string[] => buildRunnersScreen(model, t, formatTime, page).rows.flat().map((button) => button.text);
    assert.ok(labelsOf(0).includes('Next ›') && !labelsOf(0).includes('‹ Previous'));
    assert.ok(labelsOf(1).includes('Next ›') && labelsOf(1).includes('‹ Previous'));
    assert.ok(!labelsOf(pageCount - 1).includes('Next ›') && labelsOf(pageCount - 1).includes('‹ Previous'));
    assert.equal(buildRunnersScreen(model, t, formatTime, pageCount + 7).page, pageCount - 1);
    assert.equal(buildRunnersScreen(model, t, formatTime, -3).page, 0);
    const middle = buildRunnersScreen(model, t, formatTime, 1);
    assert.deepEqual(middle.rows.flat().filter((button) => button.data.startsWith('rnr_pg_')).map((button) => button.data), [buildRunnersPageCallback(0), buildRunnersPageCallback(2)]);
  });

  it('a single machine with the bulkiest report is bounded by itself, and an empty list is one page', () => {
    const screen = buildRunnersScreen({ revision, entries: [createBulkyEntry(0)], openPairingExpiries: [], isChecking: true }, t, formatTime);
    assert.equal(screen.pageCount, 1);
    assert.ok(screen.text.length < 1500, `${screen.text.length} characters`);
    const empty = buildRunnersScreen({ revision, entries: [], openPairingExpiries: [], isChecking: false }, t, formatTime, 5);
    assert.deepEqual([empty.page, empty.pageCount], [0, 1]);
  });
});

describe('what a removal came to', () => {
  it('has a text of its own for each outcome — stopped, offline, could not be stopped — and each names the machine', () => {
    const texts = (['stopped', 'offline', 'failed'] as const).map((jobs) => buildRemovalOutcomeText('mac', jobs, t));
    assert.equal(new Set(texts).size, 3, texts.join('\n'));
    assert.ok(texts.every((text) => text.startsWith('✅ mac removed.')));
    assert.match(texts[0], /jobs it was running are stopped/);
    assert.match(texts[1], /machine is offline/);
    assert.doesNotMatch(texts[2], /offline/, '«could not be stopped» does not claim the machine is offline: it may well be online');
    assert.match(texts[2], /could not be stopped from here/);
  });

  it('says how long the machine waits before it stops its jobs itself — the link loop\'s own delay, in every language — and only where the hub could not stop them', () => {
    const hours = unconfirmedRemovalStopAfterHours.toString();
    const wordsOfHours = new RegExp(`(^|[^0-9])${hours}([^0-9]|$)`);
    for (const locale of localeCodes) {
      for (const jobs of ['offline', 'failed'] as const) {
        const text = runWithLocale(locale, () => buildRemovalOutcomeText('mac', jobs, t));
        assert.match(text, wordsOfHours, `${locale} ${jobs}: the delay is named`);
        assert.doesNotMatch(text, /\{[a-z]+\}/, `${locale} ${jobs}: no placeholder is left unfilled`);
        assert.doesNotMatch(text, /once it finds out|finds out it was removed/, `${locale} ${jobs}: no promise of an immediate stop`);
      }
      const stopped = runWithLocale(locale, () => buildRemovalOutcomeText('mac', 'stopped', t));
      assert.doesNotMatch(stopped, wordsOfHours, `${locale}: jobs stopped from the hub name no delay`);
    }
    assert.match(buildRemovalOutcomeText('mac', 'offline', t), /refused for 12 h\./);
  });
});
